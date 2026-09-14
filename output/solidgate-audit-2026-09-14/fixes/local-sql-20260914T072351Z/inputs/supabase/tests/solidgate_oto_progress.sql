\set ON_ERROR_STOP on

DO $$
BEGIN
  ASSERT NOT has_function_privilege(
    'public',
    'public.advance_solidgate_oto_progress(text,uuid,integer,boolean)',
    'EXECUTE'
  ), 'PUBLIC can execute the internal OTO progress RPC';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.advance_solidgate_oto_progress(text,uuid,integer,boolean)',
    'EXECUTE'
  ), 'anon can execute the internal OTO progress RPC';
  ASSERT NOT has_function_privilege(
    'authenticated',
    'public.advance_solidgate_oto_progress(text,uuid,integer,boolean)',
    'EXECUTE'
  ), 'authenticated can execute the internal OTO progress RPC';
  ASSERT has_function_privilege(
    'service_role',
    'public.advance_solidgate_oto_progress(text,uuid,integer,boolean)',
    'EXECUTE'
  ), 'service_role cannot execute the internal OTO progress RPC';
END $$;

INSERT INTO public.sessions (id, locale, last_oto_step)
VALUES ('21406200-0000-4000-8000-000000000001', 'en', NULL)
ON CONFLICT (id) DO UPDATE
SET last_oto_step = NULL,
    solidgate_oto_environment = NULL;

DO $$
DECLARE
  v_progress RECORD;
BEGIN
  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 1, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 2 AND v_progress.advanced AND NOT v_progress.conflict,
    'OTO1 skip did not advance to OTO2';

  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 1, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 2 AND NOT v_progress.advanced AND NOT v_progress.conflict,
    'duplicate OTO1 skip was not idempotent';

  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 4, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 2
      AND NOT v_progress.advanced
      AND v_progress.conflict,
    'ordinary skip jumped over durable OTO progress';

  -- Provider-accepted purchases are authoritative and may repair missed skips.
  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 4, TRUE
  ) AS result;
  ASSERT v_progress.persisted_step = 5 AND v_progress.advanced AND NOT v_progress.conflict,
    'provider-accepted OTO4 purchase did not catch up to OTO5';

  -- A late request from an older page cannot regress the winning checkpoint.
  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 2, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 5 AND NOT v_progress.advanced AND NOT v_progress.conflict,
    'late OTO2 request regressed durable progress';

  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000001', 5, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 6 AND v_progress.advanced AND NOT v_progress.conflict,
    'canonical OTO5 skip did not advance to OTO6';

  BEGIN
    PERFORM persisted_step
    FROM public.advance_solidgate_oto_progress(
      'production', '21406200-0000-4000-8000-000000000001', 6, FALSE
    );
    RAISE EXCEPTION 'another payment environment mutated the OTO checkpoint';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM = 'oto_progress_environment_mismatch',
      format('unexpected environment mismatch error: %s', SQLERRM);
  END;

  RAISE NOTICE 'SOLIDGATE OTO PROGRESS SCENARIOS PASSED';
END $$;

DO $$
DECLARE
  v_environment TEXT;
BEGIN
  SELECT solidgate_oto_environment INTO v_environment
  FROM public.sessions
  WHERE id = '21406200-0000-4000-8000-000000000001';
  ASSERT v_environment = 'sandbox',
    format('OTO environment was not pinned to sandbox: %s', v_environment);
END $$;

DELETE FROM public.sessions
WHERE id = '21406200-0000-4000-8000-000000000001';

INSERT INTO public.sessions (id, locale, email, last_oto_step)
VALUES (
  '21406200-0000-4000-8000-000000000002',
  'en',
  'oto-progress@example.invalid',
  NULL
)
ON CONFLICT (id) DO UPDATE
SET locale = EXCLUDED.locale,
    email = EXCLUDED.email,
    last_oto_step = NULL,
    solidgate_oto_environment = NULL;

DELETE FROM public.orders
WHERE session_id = '21406200-0000-4000-8000-000000000002';

DO $$
DECLARE
  v_opened RECORD;
  v_replayed RECORD;
  v_progress RECORD;
  v_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'oto1',
    'session_id', '21406200-0000-4000-8000-000000000002',
    'product_slug', 'oto1_lifetime',
    'locale', 'en'
  );
BEGIN
  SELECT result.* INTO STRICT v_opened
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21406200-0000-4000-8000-000000000002',
    'BRANDLIFETIME_000000_SUB',
    '21406200-0000-4000-8000-000000000002:oto1_lifetime',
    100,
    'usd',
    'BRANDLIFETIME_000000_SUB',
    v_metadata,
    'oto-progress@example.invalid',
    'en',
    '21406200-0000-4000-8000-000000000011',
    NULL,
    NULL,
    'auth_settle'
  ) AS result;

  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000002', 1, FALSE
  ) AS result;
  ASSERT v_progress.persisted_step = 1
      AND NOT v_progress.advanced
      AND v_progress.conflict,
    'ordinary skip advanced past a payable OTO order';

  SELECT result.* INTO STRICT v_progress
  FROM public.advance_solidgate_oto_progress(
    'sandbox', '21406200-0000-4000-8000-000000000002', 1, TRUE
  ) AS result;
  ASSERT v_progress.persisted_step = 2
      AND v_progress.advanced
      AND NOT v_progress.conflict,
    'trusted provider acceptance did not advance past its payable OTO order';

  SELECT result.* INTO STRICT v_replayed
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21406200-0000-4000-8000-000000000002',
    'BRANDLIFETIME_000000_SUB',
    '21406200-0000-4000-8000-000000000002:oto1_lifetime',
    999,
    'eur',
    'BRANDLIFETIME_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND',
      'funnel_variant', 'oto1',
      'session_id', '21406200-0000-4000-8000-000000000002',
      'product_slug', 'oto1_lifetime',
      'locale', 'lt'
    ),
    'changed@example.invalid',
    'lt',
    '21406200-0000-4000-8000-000000000012',
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_replayed.order_db_id = v_opened.order_db_id
      AND v_replayed.bound_original_amount_cents = 100
      AND v_replayed.bound_currency = 'usd'
      AND v_replayed.bound_customer_email = 'oto-progress@example.invalid'
      AND v_replayed.bound_checkout_locale = 'en'
      AND v_replayed.bound_tracking_metadata = v_metadata,
    'post-progress exact retry did not reuse its immutable snapshot';

  RAISE NOTICE 'SOLIDGATE OTO PAYABLE/SKIP INTERLOCK SCENARIOS PASSED';
END $$;

DELETE FROM public.orders
WHERE session_id = '21406200-0000-4000-8000-000000000002';
DELETE FROM public.sessions
WHERE id = '21406200-0000-4000-8000-000000000002';
