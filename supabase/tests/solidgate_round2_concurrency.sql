\set ON_ERROR_STOP on
\if :{?round2_dblink_conn}
\else
\set round2_dblink_conn 'host=127.0.0.1 port=5432 user=postgres password=postgres'
\endif

SELECT pg_catalog.set_config(
  'round2.dblink_conn',
  :'round2_dblink_conn',
  FALSE
) AS round2_conn_configured
\gset

-- Run only against a throwaway database with the full migration chain applied.
-- dblink gives this script genuinely independent transactions, so these are
-- lock/visibility tests rather than sequential approximations of a race.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

DO $$
BEGIN
  ASSERT NOT has_function_privilege(
    'public',
    'public.claim_solidgate_webhook_event(text,text,timestamptz,text,jsonb,integer)',
    'EXECUTE'
  ), 'PUBLIC can execute the internal legacy webhook claim RPC';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.claim_solidgate_webhook_event(text,text,timestamptz,text,jsonb,integer)',
    'EXECUTE'
  ), 'anon can execute the internal legacy webhook claim RPC';
  ASSERT NOT has_function_privilege(
    'authenticated',
    'public.claim_solidgate_webhook_event(text,text,timestamptz,text,jsonb,integer)',
    'EXECUTE'
  ), 'authenticated can execute the internal legacy webhook claim RPC';
  ASSERT has_function_privilege(
    'service_role',
    'public.claim_solidgate_webhook_event(text,text,timestamptz,text,jsonb,integer)',
    'EXECUTE'
  ), 'service_role cannot execute the internal legacy webhook claim RPC';
  RAISE NOTICE 'WEBHOOK CLAIM RPC ACL SCENARIOS PASSED';
END $$;

-- Keep retries after a failed later scenario from self-deadlocking: cleanup is
-- its own committed statement before independent dblink transactions begin.
DELETE FROM public.solidgate_webhook_events
WHERE environment = 'sandbox'
  AND event_id LIKE 'round2-%';

DO $$
DECLARE
  v_database TEXT := pg_catalog.current_database();
  v_claim RECORD;
  v_legacy_claimed BOOLEAN;
  v_busy INTEGER;
  v_generation BIGINT;
BEGIN
  PERFORM extensions.dblink_connect(
    'round2-v2',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_connect(
    'round2-legacy',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_exec('round2-v2', 'BEGIN');

  SELECT result.* INTO STRICT v_claim
  FROM extensions.dblink(
    'round2-v2',
    $query$
      SELECT claim_state, claim_token::TEXT, claim_generation
      FROM public.claim_solidgate_webhook_event_v2(
        'round2-concurrent',
        'card_gate.order.updated',
        NOW(),
        'sandbox',
        '{"order":{"order_id":"round2"}}'::JSONB,
        30
      )
    $query$
  ) AS result(claim_state TEXT, claim_token TEXT, claim_generation BIGINT);
  ASSERT v_claim.claim_state = 'claimed',
    format('v2 first claim: expected claimed, got %s', v_claim.claim_state);
  ASSERT v_claim.claim_token IS NOT NULL AND v_claim.claim_generation = 1,
    'v2 first claim did not return its initial fence';

  -- The legacy Boolean call reaches the same unique row while the v2 insert is
  -- uncommitted, so it must wait rather than also reporting ownership.
  PERFORM extensions.dblink_send_query(
    'round2-legacy',
    $query$
      SELECT public.claim_solidgate_webhook_event(
        'round2-concurrent',
        'card_gate.order.updated',
        NOW(),
        'sandbox',
        '{"order":{"order_id":"round2"}}'::JSONB,
        30
      )
    $query$
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-legacy') INTO v_busy;
  ASSERT v_busy = 1, 'legacy claimant did not wait on the concurrent v2 owner';

  PERFORM extensions.dblink_exec('round2-v2', 'COMMIT');
  SELECT result.claimed INTO STRICT v_legacy_claimed
  FROM extensions.dblink_get_result('round2-legacy') AS result(claimed BOOLEAN);
  ASSERT v_legacy_claimed = FALSE,
    'legacy claimant acquired a second live claim after the v2 commit';

  ASSERT public.complete_solidgate_webhook_event_v2(
    'sandbox',
    'round2-concurrent',
    v_claim.claim_token::UUID,
    v_claim.claim_generation
  ), 'current v2 owner could not complete';

  SELECT result.* INTO STRICT v_claim
  FROM public.claim_solidgate_webhook_event_v2(
    'round2-concurrent',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2"}}'::JSONB,
    30
  ) AS result;
  ASSERT v_claim.claim_state = 'completed',
    format('completed duplicate returned %s', v_claim.claim_state);

  -- The reverse rolling race is also fenced: once v2 reclaims a stale legacy
  -- row, the displaced old handler's direct status update leaves the new token
  -- attached and is rejected by the terminal-claim constraint.
  v_legacy_claimed := public.claim_solidgate_webhook_event(
    'round2-legacy-stale',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2-legacy-stale"}}'::JSONB,
    30
  );
  ASSERT v_legacy_claimed, 'legacy worker did not acquire its initial claim';
  UPDATE public.solidgate_webhook_events
  SET processing_started_at = NOW() - INTERVAL '31 seconds'
  WHERE environment = 'sandbox' AND event_id = 'round2-legacy-stale';
  SELECT result.* INTO STRICT v_claim
  FROM public.claim_solidgate_webhook_event_v2(
    'round2-legacy-stale',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2-legacy-stale"}}'::JSONB,
    30
  ) AS result;
  ASSERT v_claim.claim_state = 'claimed' AND v_claim.claim_token IS NOT NULL,
    'v2 worker did not reclaim stale legacy row';
  BEGIN
    UPDATE public.solidgate_webhook_events
    SET status = 'completed',
        completed_at = NOW(),
        processing_started_at = NULL,
        updated_at = NOW()
    WHERE environment = 'sandbox' AND event_id = 'round2-legacy-stale';
    RAISE EXCEPTION 'displaced legacy worker overwrote the v2 claim';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%solidgate_webhook_events_terminal_claim_check%',
      format('unexpected legacy completion rejection: %s', SQLERRM);
  END;
  ASSERT public.complete_solidgate_webhook_event_v2(
    'sandbox',
    'round2-legacy-stale',
    v_claim.claim_token,
    v_claim.claim_generation
  ), 'current v2 owner could not complete after rejecting stale legacy completion';

  -- A legacy takeover must clear the old token and advance its generation.
  SELECT result.* INTO STRICT v_claim
  FROM public.claim_solidgate_webhook_event_v2(
    'round2-stale',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2-stale"}}'::JSONB,
    30
  ) AS result;
  UPDATE public.solidgate_webhook_events
  SET processing_started_at = NOW() - INTERVAL '31 seconds'
  WHERE environment = 'sandbox' AND event_id = 'round2-stale';

  v_legacy_claimed := public.claim_solidgate_webhook_event(
    'round2-stale',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2-stale"}}'::JSONB,
    30
  );
  ASSERT v_legacy_claimed, 'legacy worker did not reclaim a stale v2 lease';
  SELECT claim_generation INTO STRICT v_generation
  FROM public.solidgate_webhook_events
  WHERE environment = 'sandbox' AND event_id = 'round2-stale';
  ASSERT v_generation = v_claim.claim_generation + 1,
    'legacy takeover did not advance the claim generation';
  ASSERT NOT public.complete_solidgate_webhook_event_v2(
    'sandbox',
    'round2-stale',
    v_claim.claim_token,
    v_claim.claim_generation
  ), 'displaced v2 worker completed after a legacy takeover';

  -- Simulate the old worker's same-row completion, then prove v2 observes the
  -- durable completed state rather than treating it as claimable.
  UPDATE public.solidgate_webhook_events
  SET status = 'completed',
      completed_at = NOW(),
      processing_started_at = NULL,
      updated_at = NOW()
  WHERE environment = 'sandbox' AND event_id = 'round2-stale';
  SELECT result.* INTO STRICT v_claim
  FROM public.claim_solidgate_webhook_event_v2(
    'round2-stale',
    'card_gate.order.updated',
    NOW(),
    'sandbox',
    '{"order":{"order_id":"round2-stale"}}'::JSONB,
    30
  ) AS result;
  ASSERT v_claim.claim_state = 'completed',
    format('legacy-completed row returned %s to v2', v_claim.claim_state);

  PERFORM extensions.dblink_disconnect('round2-v2');
  PERFORM extensions.dblink_disconnect('round2-legacy');
  RAISE NOTICE 'WEBHOOK CLAIM CONCURRENCY SCENARIOS PASSED';
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-v2');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-legacy');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE;
END $$;

-- Solidgate event IDs are opaque. Authorization and settlement callbacks can
-- share a provider timestamp, so a lexically smaller settlement ID must still
-- be processed instead of being acknowledged as permanently stale.
DELETE FROM public.solidgate_entity_watermarks
WHERE entity_type = 'payment'
  AND entity_id = 'sandbox:round2-equal-time';

DO $$
DECLARE
  v_created_at TIMESTAMPTZ := '2026-07-21T12:00:00Z';
  v_claim TEXT;
BEGIN
  v_claim := public.claim_solidgate_entity_event(
    'payment', 'sandbox:round2-equal-time', v_created_at, 'z-auth', 30
  );
  ASSERT v_claim = 'claimed', format('equal-time auth claim returned %s', v_claim);
  PERFORM public.complete_solidgate_entity_event(
    'payment', 'sandbox:round2-equal-time', v_created_at, 'z-auth'
  );

  v_claim := public.claim_solidgate_entity_event(
    'payment', 'sandbox:round2-equal-time', v_created_at, 'a-settle', 30
  );
  ASSERT v_claim = 'claimed',
    format('equal-time lexically-smaller settlement returned %s', v_claim);
  PERFORM public.complete_solidgate_entity_event(
    'payment', 'sandbox:round2-equal-time', v_created_at, 'a-settle'
  );

  v_claim := public.claim_solidgate_entity_event(
    'payment', 'sandbox:round2-equal-time', v_created_at - INTERVAL '1 second',
    'older-event', 30
  );
  ASSERT v_claim = 'stale', format('strictly older event returned %s', v_claim);
  RAISE NOTICE 'ENTITY EQUAL-TIMESTAMP ORDERING SCENARIOS PASSED';
END $$;

DELETE FROM public.solidgate_entity_watermarks
WHERE entity_type = 'payment'
  AND entity_id = 'sandbox:round2-equal-time';

INSERT INTO public.sessions (id, locale, email, last_oto_step)
VALUES (
  '21000000-0000-4000-8000-000000000001',
  'en',
  'round2-oto@example.invalid',
  '5'
)
ON CONFLICT (id) DO UPDATE
SET locale = EXCLUDED.locale,
    email = EXCLUDED.email,
    last_oto_step = EXCLUDED.last_oto_step;

-- As above, commit cleanup before any remote transaction targets these rows.
DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND session_id = '21000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  v_database TEXT := pg_catalog.current_database();
  v_opened RECORD;
  v_replay RECORD;
  v_takeover RECORD;
  v_terminal_retry RECORD;
  v_uncertain_replay RECORD;
  v_error TEXT;
  v_busy INTEGER;
  v_count INTEGER;
  v_old_token UUID := '21000000-0000-4000-8000-000000000011';
  v_takeover_token UUID := '21000000-0000-4000-8000-000000000012';
  v_loser_token UUID := '21000000-0000-4000-8000-000000000013';
  v_retry_token UUID := '21000000-0000-4000-8000-000000000014';
  v_uncertain_token UUID := '21000000-0000-4000-8000-000000000015';
  v_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'oto5',
    'session_id', '21000000-0000-4000-8000-000000000001',
    'product_slug', 'oto5_pdf',
    'locale', 'en'
  );
BEGIN
  PERFORM extensions.dblink_connect(
    'round2-rpc',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_connect(
    'round2-direct',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_exec('round2-rpc', 'BEGIN');

  SELECT result.* INTO STRICT v_opened
  FROM extensions.dblink(
    'round2-rpc',
    format(
      $query$
        SELECT
          order_db_id::TEXT,
          solidgate_order_id,
          order_status,
          solidgate_payment_status,
          is_new,
          should_submit,
          needs_reconcile,
          claim_token::TEXT
        FROM public.open_solidgate_oto_order_v2(
          'sandbox',
          '21000000-0000-4000-8000-000000000001'::UUID,
          'BRANDPDF5_000000_PDF',
          '21000000-0000-4000-8000-000000000001:oto5_pdf',
          4600,
          'usd',
          'BRANDPDF5_000000_PDF',
          %L::JSONB,
          'round2-oto@example.invalid',
          'en',
          %L::UUID,
          NULL,
          NULL,
          'auth_settle'
        )
      $query$,
      v_metadata::TEXT,
      v_old_token::TEXT
    )
  ) AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    order_status TEXT,
    solidgate_payment_status TEXT,
    is_new BOOLEAN,
    should_submit BOOLEAN,
    needs_reconcile BOOLEAN,
    claim_token TEXT
  );
  ASSERT v_opened.is_new AND v_opened.should_submit AND NOT v_opened.needs_reconcile,
    'first v2 opener did not exclusively own provider submission';
  ASSERT v_opened.solidgate_order_id =
    '21000000-0000-4000-8000-000000000001:oto5_pdf:1',
    format('unexpected first OTO id: %s', v_opened.solidgate_order_id);

  -- This models the rolling-deployment insert/collision-bump loop. The trigger
  -- must block on the same advisory key, then reject after the RPC commits.
  PERFORM extensions.dblink_send_query(
    'round2-direct',
    format(
      $query$
        INSERT INTO public.orders (
          psp,
          payment_environment,
          solidgate_order_id,
          session_id,
          status,
          amount_cents,
          currency,
          product_name,
          product_slug,
          solidgate_original_amount_cents,
          solidgate_payment_action,
          solidgate_customer_email,
          solidgate_checkout_locale,
          tracking_metadata
        ) VALUES (
          'solidgate',
          'sandbox',
          '21000000-0000-4000-8000-000000000001:oto5_pdf:2',
          '21000000-0000-4000-8000-000000000001'::UUID,
          'pending',
          4600,
          'usd',
          'BRANDPDF5_000000_PDF',
          'BRANDPDF5_000000_PDF',
          4600,
          'auth_settle',
          'round2-oto@example.invalid',
          'en',
          %L::JSONB
        )
        RETURNING solidgate_order_id
      $query$,
      v_metadata::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-direct') INTO v_busy;
  ASSERT v_busy = 1, 'direct writer did not wait on the RPC advisory lock';

  PERFORM extensions.dblink_exec('round2-rpc', 'COMMIT');
  PERFORM result.solidgate_order_id
  FROM extensions.dblink_get_result('round2-direct', FALSE)
    AS result(solidgate_order_id TEXT);
  v_error := extensions.dblink_error_message('round2-direct');
  ASSERT v_error LIKE '%step is already payable, settled, or uncertain%',
    format('direct writer was not rejected after RPC commit: %s', v_error);

  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND session_id = '21000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDPDF5_000000_PDF';
  ASSERT v_count = 1, format('race produced %s OTO rows', v_count);

  SELECT result.* INTO STRICT v_replay
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    '21000000-0000-4000-8000-000000000001:oto5_pdf',
    4600,
    'usd',
    'BRANDPDF5_000000_PDF',
    v_metadata,
    'round2-oto@example.invalid',
    'en',
    v_loser_token,
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_replay.solidgate_order_id = v_opened.solidgate_order_id
    AND NOT v_replay.is_new
    AND NOT v_replay.should_submit
    AND NOT v_replay.needs_reconcile
    AND v_replay.claim_token IS NULL,
    'live submission lease exposed a second provider submitter';

  UPDATE public.orders
  SET solidgate_submission_started_at = NOW() - INTERVAL '121 seconds'
  WHERE id = v_opened.order_db_id::UUID;
  SELECT result.* INTO STRICT v_takeover
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    '21000000-0000-4000-8000-000000000001:oto5_pdf',
    4600,
    'usd',
    'BRANDPDF5_000000_PDF',
    v_metadata,
    'round2-oto@example.invalid',
    'en',
    v_takeover_token,
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_takeover.solidgate_order_id = v_opened.solidgate_order_id
    AND NOT v_takeover.is_new
    AND NOT v_takeover.should_submit
    AND v_takeover.needs_reconcile
    AND v_takeover.claim_token = v_takeover_token,
    'expired lease did not return a reconcile-only takeover on the same id';
  ASSERT NOT public.resume_solidgate_oto_order_after_absent_reconcile(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    v_opened.order_db_id::UUID,
    v_opened.solidgate_order_id,
    v_old_token
  ), 'old provider-submission token resumed after takeover';
  ASSERT public.resume_solidgate_oto_order_after_absent_reconcile(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    v_opened.order_db_id::UUID,
    v_opened.solidgate_order_id,
    v_takeover_token
  ), 'current reconcile owner could not resume the same provider id';

  -- Only an explicit terminal provider outcome with zero net money may advance
  -- to another provider identity.
  UPDATE public.orders
  SET status = 'failed',
      amount_cents = 0,
      solidgate_payment_status = 'declined',
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE id = v_opened.order_db_id::UUID;
  SELECT result.* INTO STRICT v_terminal_retry
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    '21000000-0000-4000-8000-000000000001:oto5_pdf',
    4600,
    'usd',
    'BRANDPDF5_000000_PDF',
    v_metadata,
    'round2-oto@example.invalid',
    'en',
    v_retry_token,
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_terminal_retry.solidgate_order_id =
      '21000000-0000-4000-8000-000000000001:oto5_pdf:2'
    AND v_terminal_retry.is_new
    AND v_terminal_retry.should_submit
    AND NOT v_terminal_retry.needs_reconcile
    AND v_terminal_retry.claim_token = v_retry_token,
    'explicit terminal failure did not allocate exactly attempt 2';

  -- A local failed bit with a NULL provider status is uncertain. It must keep
  -- returning the same row and the direct-writer trigger must also reject a
  -- collision-bumped attempt.
  UPDATE public.orders
  SET status = 'failed',
      amount_cents = 0,
      solidgate_payment_status = NULL,
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE id = v_terminal_retry.order_db_id;
  SELECT result.* INTO STRICT v_uncertain_replay
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21000000-0000-4000-8000-000000000001',
    'BRANDPDF5_000000_PDF',
    '21000000-0000-4000-8000-000000000001:oto5_pdf',
    4600,
    'usd',
    'BRANDPDF5_000000_PDF',
    v_metadata,
    'round2-oto@example.invalid',
    'en',
    v_uncertain_token,
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_uncertain_replay.order_db_id = v_terminal_retry.order_db_id
    AND NOT v_uncertain_replay.is_new
    AND NOT v_uncertain_replay.should_submit
    AND NOT v_uncertain_replay.needs_reconcile
    AND v_uncertain_replay.claim_token IS NULL,
    'NULL provider terminal state created or leased another attempt';
  BEGIN
    INSERT INTO public.orders (
      psp,
      payment_environment,
      solidgate_order_id,
      session_id,
      status,
      amount_cents,
      currency,
      product_name,
      product_slug,
      solidgate_original_amount_cents,
      solidgate_payment_action,
      solidgate_customer_email,
      solidgate_checkout_locale,
      tracking_metadata
    ) VALUES (
      'solidgate',
      'sandbox',
      '21000000-0000-4000-8000-000000000001:oto5_pdf:3',
      '21000000-0000-4000-8000-000000000001',
      'pending',
      4600,
      'usd',
      'BRANDPDF5_000000_PDF',
      'BRANDPDF5_000000_PDF',
      4600,
      'auth_settle',
      'round2-oto@example.invalid',
      'en',
      v_metadata
    );
    RAISE EXCEPTION 'direct writer bypassed an uncertain OTO row';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM LIKE '%step is already payable, settled, or uncertain%',
      format('unexpected direct-writer rejection: %s', SQLERRM);
  END;

  PERFORM extensions.dblink_disconnect('round2-rpc');
  PERFORM extensions.dblink_disconnect('round2-direct');
  RAISE NOTICE 'OTO OPEN/SUBMISSION CONCURRENCY SCENARIOS PASSED';
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-rpc');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-direct');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE;
END $$;

DELETE FROM public.orders
WHERE session_id = '21000000-0000-4000-8000-000000000001'
  AND payment_environment = 'sandbox';
DELETE FROM public.sessions
WHERE id = '21000000-0000-4000-8000-000000000001';

-- ── OTO3 mutually-exclusive product variants ───────────────────────
INSERT INTO public.sessions (id, locale, email, last_oto_step)
VALUES (
  '21000000-0000-4000-8000-000000000002',
  'en',
  'round2-oto3@example.invalid',
  '3'
)
ON CONFLICT (id) DO UPDATE
SET locale = EXCLUDED.locale,
    email = EXCLUDED.email,
    last_oto_step = EXCLUDED.last_oto_step,
    solidgate_oto_environment = NULL;

DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND session_id = '21000000-0000-4000-8000-000000000002';

DO $$
DECLARE
  v_database TEXT := pg_catalog.current_database();
  v_owner RECORD;
  v_replay RECORD;
  v_error TEXT;
  v_busy INTEGER;
  v_count INTEGER;
  v_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'oto3',
    'session_id', '21000000-0000-4000-8000-000000000002',
    'product_slug', 'oto3_bundle_all',
    'locale', 'en',
    'utm_source', 'historic-source'
  );
  v_fresh_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'oto3',
    'session_id', '21000000-0000-4000-8000-000000000002',
    'product_slug', 'oto3_bundle_all',
    'locale', 'lt',
    'utm_source', 'fresh-source'
  );
BEGIN
  FOREACH v_error IN ARRAY ARRAY['round2-oto3-owner', 'round2-oto3-soul',
                                  'round2-oto3-love', 'round2-oto3-energy']
  LOOP
    PERFORM extensions.dblink_connect(
      v_error,
      format(
        '%s dbname=%s',
        pg_catalog.current_setting('round2.dblink_conn'),
        v_database
      )
    );
  END LOOP;

  PERFORM extensions.dblink_exec('round2-oto3-owner', 'BEGIN');
  SELECT result.* INTO STRICT v_owner
  FROM extensions.dblink(
    'round2-oto3-owner',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id
        FROM public.open_solidgate_oto_order_v2(
          'sandbox',
          '21000000-0000-4000-8000-000000000002'::UUID,
          'BRANDBUNDLE_000000_PDF',
          '21000000-0000-4000-8000-000000000002:oto3_bundle_all',
          3900,
          'usd',
          'BRANDBUNDLE_000000_PDF',
          %L::JSONB,
          'round2-oto3@example.invalid',
          'en',
          '21000000-0000-4000-8000-000000000021'::UUID,
          NULL,
          NULL,
          'auth_settle'
        )
      $query$,
      v_metadata::TEXT
    )
  ) AS result(order_db_id TEXT, solidgate_order_id TEXT);

  PERFORM extensions.dblink_send_query(
    'round2-oto3-soul',
    $query$
      SELECT solidgate_order_id
      FROM public.open_solidgate_oto_order_v2(
        'sandbox',
        '21000000-0000-4000-8000-000000000002'::UUID,
        'BRANDBUNDLE1_000000_PDF',
        '21000000-0000-4000-8000-000000000002:oto3_bundle_1',
        1900,
        'usd',
        'BRANDBUNDLE1_000000_PDF',
        '{"funnel_code":"BRAND","funnel_variant":"oto3","session_id":"21000000-0000-4000-8000-000000000002","product_slug":"oto3_bundle_1","locale":"en"}'::JSONB,
        'round2-oto3@example.invalid',
        'en',
        '21000000-0000-4000-8000-000000000022'::UUID,
        NULL,
        NULL,
        'auth_settle'
      )
    $query$
  );
  PERFORM extensions.dblink_send_query(
    'round2-oto3-love',
    $query$
      SELECT solidgate_order_id
      FROM public.open_solidgate_oto_order_v2(
        'sandbox',
        '21000000-0000-4000-8000-000000000002'::UUID,
        'BRANDBUNDLE2_000000_PDF',
        '21000000-0000-4000-8000-000000000002:oto3_bundle_2',
        1900,
        'usd',
        'BRANDBUNDLE2_000000_PDF',
        '{"funnel_code":"BRAND","funnel_variant":"oto3","session_id":"21000000-0000-4000-8000-000000000002","product_slug":"oto3_bundle_2","locale":"en"}'::JSONB,
        'round2-oto3@example.invalid',
        'en',
        '21000000-0000-4000-8000-000000000023'::UUID,
        NULL,
        NULL,
        'auth_settle'
      )
    $query$
  );
  PERFORM extensions.dblink_send_query(
    'round2-oto3-energy',
    $query$
      SELECT solidgate_order_id
      FROM public.open_solidgate_oto_order_v2(
        'sandbox',
        '21000000-0000-4000-8000-000000000002'::UUID,
        'BRANDBUNDLE3_000000_PDF',
        '21000000-0000-4000-8000-000000000002:oto3_bundle_3',
        1900,
        'usd',
        'BRANDBUNDLE3_000000_PDF',
        '{"funnel_code":"BRAND","funnel_variant":"oto3","session_id":"21000000-0000-4000-8000-000000000002","product_slug":"oto3_bundle_3","locale":"en"}'::JSONB,
        'round2-oto3@example.invalid',
        'en',
        '21000000-0000-4000-8000-000000000024'::UUID,
        NULL,
        NULL,
        'auth_settle'
      )
    $query$
  );

  PERFORM pg_catalog.pg_sleep(0.15);
  FOREACH v_error IN ARRAY ARRAY['round2-oto3-soul', 'round2-oto3-love',
                                  'round2-oto3-energy']
  LOOP
    SELECT extensions.dblink_is_busy(v_error) INTO v_busy;
    ASSERT v_busy = 1, format('%s did not wait on the shared OTO3 step lock', v_error);
  END LOOP;

  PERFORM extensions.dblink_exec('round2-oto3-owner', 'COMMIT');
  FOREACH v_error IN ARRAY ARRAY['round2-oto3-soul', 'round2-oto3-love',
                                  'round2-oto3-energy']
  LOOP
    PERFORM result.solidgate_order_id
    FROM extensions.dblink_get_result(v_error, FALSE)
      AS result(solidgate_order_id TEXT);
    ASSERT extensions.dblink_error_message(v_error) LIKE '%oto_step_already_bound%',
      format('%s was not rejected by the shared OTO3 binding: %s',
             v_error, extensions.dblink_error_message(v_error));
  END LOOP;

  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND session_id = '21000000-0000-4000-8000-000000000002'
    AND public.solidgate_oto_step_from_product_slug(product_slug) = 3
    AND (
      status IS DISTINCT FROM 'failed'
      OR amount_cents IS DISTINCT FROM 0
      OR solidgate_payment_status IS NULL
      OR solidgate_payment_status
           NOT IN ('auth_failed', 'declined', 'void_ok', 'request_rejected')
    );
  ASSERT v_count = 1, format('OTO3 product race produced %s payable rows', v_count);

  PERFORM public.advance_solidgate_oto_progress(
    'sandbox',
    '21000000-0000-4000-8000-000000000002',
    3,
    TRUE
  );

  -- Exact recovery remains legal after accepted progress moves forward and
  -- ignores mutable fresh price/currency/email/locale/UTM input.
  SELECT result.* INTO STRICT v_replay
  FROM public.open_solidgate_oto_order_v2(
    'sandbox',
    '21000000-0000-4000-8000-000000000002',
    'BRANDBUNDLE_000000_PDF',
    '21000000-0000-4000-8000-000000000002:oto3_bundle_all',
    9999,
    'eur',
    'BRANDBUNDLE_000000_PDF',
    v_fresh_metadata,
    'fresh-oto3@example.invalid',
    'lt',
    '21000000-0000-4000-8000-000000000025',
    NULL,
    NULL,
    'auth_settle'
  ) AS result;
  ASSERT v_replay.order_db_id = v_owner.order_db_id::UUID
      AND v_replay.solidgate_order_id = v_owner.solidgate_order_id
      AND v_replay.bound_original_amount_cents = 3900
      AND v_replay.bound_currency = 'usd'
      AND v_replay.bound_customer_email = 'round2-oto3@example.invalid'
      AND v_replay.bound_checkout_locale = 'en'
      AND v_replay.bound_tracking_metadata = v_metadata,
    'exact OTO3 retry did not preserve the immutable order snapshot';

  BEGIN
    PERFORM solidgate_order_id
    FROM public.open_solidgate_oto_order_v2(
      'sandbox',
      '21000000-0000-4000-8000-000000000002',
      'BRANDBUNDLE1_000000_PDF',
      '21000000-0000-4000-8000-000000000002:oto3_bundle_1',
      1900,
      'usd',
      'BRANDBUNDLE1_000000_PDF',
      '{"funnel_code":"BRAND","funnel_variant":"oto3","session_id":"21000000-0000-4000-8000-000000000002","product_slug":"oto3_bundle_1","locale":"en"}'::JSONB,
      'round2-oto3@example.invalid',
      'en',
      '21000000-0000-4000-8000-000000000026',
      NULL,
      NULL,
      'auth_settle'
    );
    RAISE EXCEPTION 'a stale OTO3 variant opened after another variant won';
  EXCEPTION WHEN unique_violation THEN
    ASSERT SQLERRM = 'oto_step_already_bound',
      format('unexpected stale OTO3 variant rejection: %s', SQLERRM);
  END;

  FOREACH v_error IN ARRAY ARRAY['round2-oto3-owner', 'round2-oto3-soul',
                                  'round2-oto3-love', 'round2-oto3-energy']
  LOOP
    PERFORM extensions.dblink_disconnect(v_error);
  END LOOP;
  RAISE NOTICE 'OTO3 MUTUALLY-EXCLUSIVE VARIANT SCENARIOS PASSED';
EXCEPTION WHEN OTHERS THEN
  FOREACH v_error IN ARRAY ARRAY['round2-oto3-owner', 'round2-oto3-soul',
                                  'round2-oto3-love', 'round2-oto3-energy']
  LOOP
    BEGIN
      PERFORM extensions.dblink_disconnect(v_error);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RAISE;
END $$;

DELETE FROM public.orders
WHERE session_id = '21000000-0000-4000-8000-000000000002'
  AND payment_environment = 'sandbox';
DELETE FROM public.sessions
WHERE id = '21000000-0000-4000-8000-000000000002';

-- ── Main hosted checkout identity and builder fence ─────────────────
INSERT INTO auth.users (id, email)
VALUES (
  '23000000-0000-4000-8000-000000000010',
  'solidgate-round2-main@example.invalid'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sessions (id, locale)
VALUES
  ('23000000-0000-4000-8000-000000000001', 'en'),
  ('23000000-0000-4000-8000-000000000002', 'en'),
  ('23000000-0000-4000-8000-000000000003', 'en')
ON CONFLICT (id) DO NOTHING;

-- Commit cleanup before independent dblink transactions acquire these keys.
-- This also makes a rerun safe after any later assertion aborts.
DELETE FROM public.entitlements
WHERE payment_environment = 'sandbox'
  AND user_id = '23000000-0000-4000-8000-000000000010';
DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND session_id IN (
    '23000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000002',
    '23000000-0000-4000-8000-000000000003'
  );

-- Establish an exact terminal main-checkout history row. The final identity
-- migration makes both customer identity and original gross immutable, so a
-- post-cutover test must never manufacture the old NULL-gross state.
INSERT INTO public.orders (
  id, psp, payment_environment, solidgate_order_id, session_id, status,
  amount_cents, currency, product_name, product_slug,
  solidgate_original_amount_cents, solidgate_payment_status,
  solidgate_customer_email, solidgate_checkout_locale,
  solidgate_product_id, solidgate_payment_action, tracking_metadata
) VALUES (
  '23000000-0000-4000-8000-000000000020',
  'solidgate', 'sandbox',
  '23000000-0000-4000-8000-000000000003:trial2:1',
  '23000000-0000-4000-8000-000000000003',
  'failed', 900, 'usd', 'BRAND_000000_SUB', 'BRAND_000000_SUB',
  900, 'declined',
  'solidgate-round2-main@example.invalid', 'en',
  'product-round2-main-repair', 'auth_settle',
  '{"funnel_code":"BRAND","funnel_variant":"round2-main-ledger-repair","session_id":"23000000-0000-4000-8000-000000000003","product_slug":"trial2","price_id":"price-round2-main-trial2-repair"}'::JSONB
);

UPDATE public.orders
SET amount_cents = 0
WHERE id = '23000000-0000-4000-8000-000000000020';

DO $$
DECLARE
  v_database TEXT := pg_catalog.current_database();
  v_owner RECORD;
  v_follower RECORD;
  v_direct_first RECORD;
  v_takeover RECORD;
  v_cached RECORD;
  v_terminal_retry RECORD;
  v_entitlement RECORD;
  v_granted BOOLEAN;
  v_error TEXT;
  v_busy INTEGER;
  v_count INTEGER;
  v_owner_token UUID := '23000000-0000-4000-8000-000000000011';
  v_follower_token UUID := '23000000-0000-4000-8000-000000000012';
  v_direct_follower_token UUID := '23000000-0000-4000-8000-000000000013';
  v_takeover_token UUID := '23000000-0000-4000-8000-000000000014';
  v_retry_token UUID := '23000000-0000-4000-8000-000000000015';
  v_rpc_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'round2-main-rpc-first',
    'session_id', '23000000-0000-4000-8000-000000000001',
    'product_slug', 'trial1',
    'price_id', 'price-round2-main-trial1'
  );
  v_direct_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'round2-main-direct-first',
    'session_id', '23000000-0000-4000-8000-000000000002',
    'product_slug', 'trial2',
    'price_id', 'price-round2-main-trial2'
  );
  v_retry_metadata JSONB := jsonb_build_object(
    'funnel_code', 'BRAND',
    'funnel_variant', 'round2-main-ledger-repair',
    'session_id', '23000000-0000-4000-8000-000000000003',
    'product_slug', 'trial2',
    'price_id', 'price-round2-main-trial2-repair'
  );
  v_merchant_data JSONB := jsonb_build_object(
    'merchant', 'round2-main-merchant',
    'paymentIntent', 'round2-main-intent',
    'signature', 'round2-main-signature'
  );
BEGIN
  PERFORM extensions.dblink_connect(
    'round2-main-owner',
    format('%s dbname=%s', pg_catalog.current_setting('round2.dblink_conn'), v_database)
  );
  PERFORM extensions.dblink_connect(
    'round2-main-follower',
    format('%s dbname=%s', pg_catalog.current_setting('round2.dblink_conn'), v_database)
  );
  PERFORM extensions.dblink_connect(
    'round2-main-direct',
    format('%s dbname=%s', pg_catalog.current_setting('round2.dblink_conn'), v_database)
  );

  -- RPC-first: a second RPC and a rolling direct insert both wait. After the
  -- owner commits, the follower reuses attempt 1 and direct attempt 2 loses.
  PERFORM extensions.dblink_exec('round2-main-owner', 'BEGIN');
  SELECT result.* INTO STRICT v_owner
  FROM extensions.dblink(
    'round2-main-owner',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new, should_build,
               merchant_data::TEXT
        FROM public.open_solidgate_main_checkout_v2(
          'sandbox',
          '23000000-0000-4000-8000-000000000001'::UUID,
          'trial1', 'BRAND_000000_SUB', 500, 'usd',
          'BRAND_000000_SUB', %L::JSONB, %L::UUID,
          'solidgate-round2-main@example.invalid', 'en',
          'product-round2-main-trial1', 'auth_settle', NULL
        )
      $query$,
      v_rpc_metadata::TEXT,
      v_owner_token::TEXT
    )
  ) AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    merchant_data TEXT
  );
  ASSERT v_owner.is_new AND v_owner.should_build
    AND v_owner.merchant_data IS NULL,
    'first main opener did not exclusively own merchant-data construction';
  ASSERT v_owner.solidgate_order_id =
      '23000000-0000-4000-8000-000000000001:trial1:1',
    format('unexpected first main order id: %s', v_owner.solidgate_order_id);

  PERFORM extensions.dblink_send_query(
    'round2-main-follower',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new, should_build,
               merchant_data::TEXT
        FROM public.open_solidgate_main_checkout_v2(
          'sandbox',
          '23000000-0000-4000-8000-000000000001'::UUID,
          'trial1', 'BRAND_000000_SUB', 500, 'usd',
          'BRAND_000000_SUB', %L::JSONB, %L::UUID,
          'solidgate-round2-main@example.invalid', 'en',
          'product-round2-main-trial1', 'auth_settle', NULL
        )
      $query$,
      v_rpc_metadata::TEXT,
      v_follower_token::TEXT
    )
  );
  PERFORM extensions.dblink_send_query(
    'round2-main-direct',
    format(
      $query$
        INSERT INTO public.orders (
          psp, payment_environment, solidgate_order_id, session_id, status,
          amount_cents, currency, product_name, product_slug,
          solidgate_customer_email, solidgate_checkout_locale,
          solidgate_product_id, solidgate_payment_action, tracking_metadata
        ) VALUES (
          'solidgate', 'sandbox',
          '23000000-0000-4000-8000-000000000001:trial1:2',
          '23000000-0000-4000-8000-000000000001'::UUID,
          'pending', 500, 'usd', 'BRAND_000000_SUB',
          'BRAND_000000_SUB',
          'solidgate-round2-main@example.invalid', 'en',
          'product-round2-main-trial1', 'auth_settle', %L::JSONB
        )
        RETURNING solidgate_order_id
      $query$,
      v_rpc_metadata::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-main-follower') INTO v_busy;
  ASSERT v_busy = 1, 'main RPC follower did not wait on the owner lock';
  SELECT extensions.dblink_is_busy('round2-main-direct') INTO v_busy;
  ASSERT v_busy = 1, 'main direct writer did not wait on the owner lock';

  PERFORM extensions.dblink_exec('round2-main-owner', 'COMMIT');
  SELECT result.* INTO STRICT v_follower
  FROM extensions.dblink_get_result('round2-main-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    merchant_data TEXT
  );
  ASSERT v_follower.order_db_id = v_owner.order_db_id
    AND v_follower.solidgate_order_id = v_owner.solidgate_order_id
    AND NOT v_follower.is_new
    AND NOT v_follower.should_build
    AND v_follower.merchant_data IS NULL,
    'concurrent main RPC follower received another identity or builder lease';
  PERFORM result.order_db_id
  FROM extensions.dblink_get_result('round2-main-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    merchant_data TEXT
  );

  PERFORM result.solidgate_order_id
  FROM extensions.dblink_get_result('round2-main-direct', FALSE)
    AS result(solidgate_order_id TEXT);
  v_error := extensions.dblink_error_message('round2-main-direct');
  ASSERT v_error LIKE '%already payable or settled%',
    format('main direct writer was not rejected after RPC commit: %s', v_error);
  -- fail_on_error = false leaves libpq's final empty result to consume before
  -- this connection can begin the reverse-order race below.
  PERFORM result.solidgate_order_id
  FROM extensions.dblink_get_result('round2-main-direct', FALSE)
    AS result(solidgate_order_id TEXT);

  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND session_id = '23000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRAND_000000_SUB';
  ASSERT v_count = 1, format('RPC-first main race produced %s rows', v_count);
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_owner.order_db_id::UUID
      AND amount_cents = 500
      AND solidgate_original_amount_cents = 500
  ), 'fresh main RPC opener did not persist exact immutable gross';

  -- Direct-first: the RPC waits, then adopts exact attempt 1 and becomes the
  -- sole builder instead of manufacturing a second Solidgate identity.
  PERFORM extensions.dblink_exec('round2-main-direct', 'BEGIN');
  PERFORM result.solidgate_order_id
  FROM extensions.dblink(
    'round2-main-direct',
    format(
      $query$
        INSERT INTO public.orders (
          psp, payment_environment, solidgate_order_id, session_id, status,
          amount_cents, currency, product_name, product_slug,
          solidgate_customer_email, solidgate_checkout_locale,
          solidgate_product_id, solidgate_payment_action, tracking_metadata
        ) VALUES (
          'solidgate', 'sandbox',
          '23000000-0000-4000-8000-000000000002:trial2:1',
          '23000000-0000-4000-8000-000000000002'::UUID,
          'pending', 900, 'usd', 'BRAND_000000_SUB',
          'BRAND_000000_SUB',
          'solidgate-round2-main@example.invalid', 'en',
          'product-round2-main-trial2', 'auth_settle', %L::JSONB
        )
        RETURNING solidgate_order_id
      $query$,
      v_direct_metadata::TEXT
    )
  ) AS result(solidgate_order_id TEXT);

  PERFORM extensions.dblink_send_query(
    'round2-main-follower',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new, should_build,
               merchant_data::TEXT
        FROM public.open_solidgate_main_checkout_v2(
          'sandbox',
          '23000000-0000-4000-8000-000000000002'::UUID,
          'trial2', 'BRAND_000000_SUB', 900, 'usd',
          'BRAND_000000_SUB', %L::JSONB, %L::UUID,
          'solidgate-round2-main@example.invalid', 'en',
          'product-round2-main-trial2', 'auth_settle', NULL
        )
      $query$,
      v_direct_metadata::TEXT,
      v_direct_follower_token::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-main-follower') INTO v_busy;
  ASSERT v_busy = 1, 'main RPC did not wait on the direct-first writer';

  PERFORM extensions.dblink_exec('round2-main-direct', 'COMMIT');
  SELECT result.* INTO STRICT v_direct_first
  FROM extensions.dblink_get_result('round2-main-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    merchant_data TEXT
  );
  ASSERT v_direct_first.solidgate_order_id =
      '23000000-0000-4000-8000-000000000002:trial2:1'
    AND NOT v_direct_first.is_new
    AND v_direct_first.should_build
    AND v_direct_first.merchant_data IS NULL,
    'direct-first main row was not reused as the sole builder identity';
  PERFORM result.order_db_id
  FROM extensions.dblink_get_result('round2-main-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    merchant_data TEXT
  );

  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND session_id = '23000000-0000-4000-8000-000000000002'
    AND product_slug = 'BRAND_000000_SUB';
  ASSERT v_count = 1, format('direct-first main race produced %s rows', v_count);
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_direct_first.order_db_id::UUID
      AND amount_cents = 900
      AND solidgate_original_amount_cents = 900
  ), 'rolling direct main writer was not normalized to exact immutable gross';

  -- A dead builder can be replaced only on the same provider identity.
  UPDATE public.solidgate_main_checkout_states
  SET build_started_at = NOW() - INTERVAL '31 seconds'
  WHERE payment_environment = 'sandbox'
    AND session_id = '23000000-0000-4000-8000-000000000002'
    AND product_slug = 'BRAND_000000_SUB';

  SELECT result.* INTO STRICT v_takeover
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox', '23000000-0000-4000-8000-000000000002',
    'trial2', 'BRAND_000000_SUB', 900, 'usd',
    'BRAND_000000_SUB', v_direct_metadata, v_takeover_token,
    'solidgate-round2-main@example.invalid', 'en',
    'product-round2-main-trial2', 'auth_settle', NULL
  ) AS result;
  ASSERT v_takeover.order_db_id = v_direct_first.order_db_id::UUID
    AND v_takeover.solidgate_order_id = v_direct_first.solidgate_order_id
    AND NOT v_takeover.is_new
    AND v_takeover.should_build
    AND v_takeover.merchant_data IS NULL,
    'expired main builder lease did not move on the same provider identity';

  BEGIN
    PERFORM public.finalize_solidgate_main_checkout(
      'sandbox', '23000000-0000-4000-8000-000000000002',
      'trial2', 'BRAND_000000_SUB', v_direct_first.order_db_id::UUID,
      v_direct_first.solidgate_order_id, 900, 'usd', v_direct_follower_token,
      '{"merchant":"stale","paymentIntent":"stale","signature":"stale"}'::JSONB
    );
    RAISE EXCEPTION 'displaced main builder finalized merchant data';
  EXCEPTION WHEN serialization_failure THEN
    ASSERT SQLERRM LIKE '%builder lost ownership%',
      format('unexpected stale main builder rejection: %s', SQLERRM);
  END;

  ASSERT public.finalize_solidgate_main_checkout(
    'sandbox', '23000000-0000-4000-8000-000000000002',
    'trial2', 'BRAND_000000_SUB', v_direct_first.order_db_id::UUID,
    v_direct_first.solidgate_order_id, 900, 'usd', v_takeover_token,
    v_merchant_data
  ) = v_merchant_data,
    'current main builder could not publish merchant data';

  SELECT result.* INTO STRICT v_cached
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox', '23000000-0000-4000-8000-000000000002',
    'trial2', 'BRAND_000000_SUB', 900, 'usd',
    'BRAND_000000_SUB', v_direct_metadata, v_follower_token,
    'solidgate-round2-main@example.invalid', 'en',
    'product-round2-main-trial2', 'auth_settle', NULL
  ) AS result;
  ASSERT v_cached.order_db_id = v_direct_first.order_db_id::UUID
    AND v_cached.solidgate_order_id = v_direct_first.solidgate_order_id
    AND NOT v_cached.is_new
    AND NOT v_cached.should_build
    AND v_cached.merchant_data = v_merchant_data,
    'finalized main merchant data was not replayed exactly';

  -- A terminal normalizer reduced net to zero while immutable gross remains
  -- 900. The next opener must advance to exactly N+1 without rewriting history.
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = '23000000-0000-4000-8000-000000000020'
      AND amount_cents = 0
      AND solidgate_original_amount_cents = 900
  ), 'terminal main checkout fixture lost its immutable gross';

  SELECT result.* INTO STRICT v_terminal_retry
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox', '23000000-0000-4000-8000-000000000003',
    'trial2', 'BRAND_000000_SUB', 900, 'usd',
    'BRAND_000000_SUB', v_retry_metadata, v_retry_token,
    'solidgate-round2-main@example.invalid', 'en',
    'product-round2-main-repair', 'auth_settle', NULL
  ) AS result;
  ASSERT v_terminal_retry.solidgate_order_id =
      '23000000-0000-4000-8000-000000000003:trial2:2'
    AND v_terminal_retry.is_new
    AND v_terminal_retry.should_build
    AND v_terminal_retry.merchant_data IS NULL,
    'terminal main retry did not allocate a clean attempt 2';
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = '23000000-0000-4000-8000-000000000020'
      AND amount_cents = 0
      AND solidgate_original_amount_cents = 900
  ), 'terminal retry rewrote the previous order gross';

  BEGIN
    UPDATE public.orders
    SET solidgate_original_amount_cents = 1
    WHERE id = v_terminal_retry.order_db_id;
    RAISE EXCEPTION 'main original gross was mutable after insertion';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%original amount is immutable%',
      format('unexpected main gross mutation rejection: %s', SQLERRM);
  END;

  -- Every tested main key has exactly one payable/uncertain identity, and its
  -- singleton state row is joined to that exact key.
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT order_row.payment_environment, order_row.session_id,
           order_row.product_slug
    FROM public.orders AS order_row
    WHERE order_row.payment_environment = 'sandbox'
      AND order_row.session_id IN (
        '23000000-0000-4000-8000-000000000001',
        '23000000-0000-4000-8000-000000000002'
      )
      AND order_row.psp = 'solidgate'
      AND order_row.product_slug = 'BRAND_000000_SUB'
      AND (
        order_row.status IS DISTINCT FROM 'failed'
        OR order_row.solidgate_payment_status IS NULL
        OR order_row.solidgate_payment_status NOT IN (
          'auth_failed', 'declined', 'void_ok'
        )
      )
    GROUP BY order_row.payment_environment, order_row.session_id,
             order_row.product_slug
    HAVING COUNT(*) <> 1
  ) AS broken_invariant;
  ASSERT v_count = 0,
    format('%s main checkout keys do not have exactly one live identity', v_count);

  SELECT COUNT(*) INTO v_count
  FROM public.orders AS order_row
  WHERE order_row.payment_environment = 'sandbox'
    AND order_row.session_id IN (
      '23000000-0000-4000-8000-000000000001',
      '23000000-0000-4000-8000-000000000002'
    )
    AND order_row.psp = 'solidgate'
    AND order_row.product_slug = 'BRAND_000000_SUB'
    AND (
      order_row.status IS DISTINCT FROM 'failed'
      OR order_row.solidgate_payment_status IS NULL
      OR order_row.solidgate_payment_status NOT IN (
        'auth_failed', 'declined', 'void_ok'
      )
    );
  ASSERT v_count = 2,
    format('expected one live main identity for each of two keys, found %s', v_count);

  SELECT COUNT(*) INTO v_count
  FROM public.solidgate_main_checkout_states AS checkout
  JOIN public.orders AS order_row ON order_row.id = checkout.order_db_id
  WHERE checkout.payment_environment = 'sandbox'
    AND checkout.session_id IN (
      '23000000-0000-4000-8000-000000000001',
      '23000000-0000-4000-8000-000000000002'
    )
    AND checkout.product_slug = 'BRAND_000000_SUB'
    AND order_row.session_id = checkout.session_id
    AND order_row.payment_environment = checkout.payment_environment
    AND order_row.product_slug = checkout.product_slug;
  ASSERT v_count = 2,
    format('expected two exact main state/order bindings, found %s', v_count);

  -- Commit a webhook-style order winner independently, then leave its
  -- authoritative entitlement insert uncommitted. The browser RPC must wait
  -- on the unique entitlement key and preserve the webhook row byte-for-byte.
  PERFORM extensions.dblink_exec(
    'round2-main-owner',
    format(
      $query$
        UPDATE public.orders
        SET status = 'trialing',
            user_id = '23000000-0000-4000-8000-000000000010'::UUID,
            solidgate_subscription_id = 'sub-round2-main',
            solidgate_payment_status = 'settle_ok'
        WHERE id = %L::UUID
      $query$,
      v_owner.order_db_id
    )
  );
  DELETE FROM public.entitlements
  WHERE payment_environment = 'sandbox'
    AND user_id = '23000000-0000-4000-8000-000000000010'
    AND product_slug = 'BRAND_000000_SUB';

  PERFORM extensions.dblink_exec('round2-main-owner', 'BEGIN');
  PERFORM extensions.dblink_exec(
    'round2-main-owner',
    format(
      $query$
        INSERT INTO public.entitlements (
          payment_environment, user_id, product_slug, access_level, status,
          order_id, expires_at, source, solidgate_subscription_id, revoked_at
        ) VALUES (
          'sandbox', '23000000-0000-4000-8000-000000000010'::UUID,
          'BRAND_000000_SUB', 'trial', 'active', %L::UUID,
          '2031-08-15T12:00:00Z'::TIMESTAMPTZ, 'solidgate_webhook',
          'sub-round2-main', NULL
        )
      $query$,
      v_owner.order_db_id
    )
  );
  PERFORM extensions.dblink_send_query(
    'round2-main-follower',
    format(
      $query$
        SELECT public.grant_solidgate_main_entitlement(
          'sandbox', %L::UUID,
          '23000000-0000-4000-8000-000000000010'::UUID,
          'BRAND_000000_SUB', 'sub-round2-main', 500,
          '2026-07-28T12:00:00Z'::TIMESTAMPTZ
        )
      $query$,
      v_owner.order_db_id
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-main-follower') INTO v_busy;
  ASSERT v_busy = 1,
    'browser entitlement grant did not wait on concurrent webhook insert';
  PERFORM extensions.dblink_exec('round2-main-owner', 'COMMIT');
  SELECT result.granted INTO STRICT v_granted
  FROM extensions.dblink_get_result('round2-main-follower') AS result(granted BOOLEAN);
  ASSERT v_granted, 'browser did not accept the authoritative webhook entitlement';

  SELECT entitlement.* INTO STRICT v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = 'sandbox'
    AND entitlement.user_id = '23000000-0000-4000-8000-000000000010'
    AND entitlement.product_slug = 'BRAND_000000_SUB';
  ASSERT v_entitlement.status = 'active'
    AND v_entitlement.access_level = 'trial'
    AND v_entitlement.expires_at = '2031-08-15T12:00:00Z'::TIMESTAMPTZ
    AND v_entitlement.source = 'solidgate_webhook',
    'late browser grant replaced authoritative webhook status/access/expiry/source';

  -- A dunning winner is preserved but is not reported as a fresh active grant.
  UPDATE public.entitlements
  SET status = 'past_due',
      access_level = 'grace',
      expires_at = '2031-08-18T12:00:00Z',
      source = 'solidgate_subscription_lifecycle'
  WHERE id = v_entitlement.id;
  v_granted := public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2026-07-28T12:00:00Z'
  );
  ASSERT NOT v_granted, 'browser reported a past-due entitlement as newly active';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE id = v_entitlement.id
      AND status = 'past_due'
      AND access_level = 'grace'
      AND expires_at = '2031-08-18T12:00:00Z'::TIMESTAMPTZ
      AND source = 'solidgate_subscription_lifecycle'
  ), 'browser overwrote authoritative dunning state';

  -- Settlement may commit before the webhook reaches entitlement provisioning.
  -- The browser fills that exact gap once and replay never extends +7d again.
  DELETE FROM public.entitlements WHERE id = v_entitlement.id;
  v_granted := public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2026-07-28T12:00:00Z'
  );
  ASSERT v_granted, 'settled order with missing entitlement was not repaired';
  v_granted := public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2035-01-01T00:00:00Z'
  );
  ASSERT v_granted, 'same-order active entitlement replay was not idempotent';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox'
      AND user_id = '23000000-0000-4000-8000-000000000010'
      AND product_slug = 'BRAND_000000_SUB'
      AND expires_at = '2026-07-28T12:00:00Z'::TIMESTAMPTZ
      AND source = 'solidgate_grant'
  ), 'browser replay extended its own fallback expiry';

  -- The reverse order is safe too: a later webhook upsert remains authoritative.
  INSERT INTO public.entitlements (
    payment_environment, user_id, product_slug, access_level, status,
    order_id, expires_at, source, solidgate_subscription_id, revoked_at
  ) VALUES (
    'sandbox', '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'trial', 'active', v_owner.order_db_id::UUID,
    '2032-01-01T00:00:00Z', 'solidgate_webhook', 'sub-round2-main', NULL
  )
  ON CONFLICT (payment_environment, user_id, product_slug) DO UPDATE
  SET access_level = EXCLUDED.access_level,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      source = EXCLUDED.source,
      order_id = EXCLUDED.order_id,
      solidgate_subscription_id = EXCLUDED.solidgate_subscription_id,
      revoked_at = NULL;
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox'
      AND user_id = '23000000-0000-4000-8000-000000000010'
      AND product_slug = 'BRAND_000000_SUB'
      AND access_level = 'trial'
      AND expires_at = '2032-01-01T00:00:00Z'::TIMESTAMPTZ
      AND source = 'solidgate_webhook'
  ), 'authoritative webhook could not replace browser fallback';

  -- Defense in depth: an under-capture or partial refund cannot create access
  -- merely because the service-role caller named the immutable gross.
  DELETE FROM public.entitlements
  WHERE payment_environment = 'sandbox'
    AND user_id = '23000000-0000-4000-8000-000000000010'
    AND product_slug = 'BRAND_000000_SUB';
  UPDATE public.orders
  SET amount_cents = 400,
      solidgate_payment_status = 'partial_settled'
  WHERE id = v_owner.order_db_id::UUID;
  ASSERT NOT public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2026-07-28T12:00:00Z'
  ), 'under-captured main order received browser entitlement';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox'
      AND user_id = '23000000-0000-4000-8000-000000000010'
      AND product_slug = 'BRAND_000000_SUB'
  ), 'under-capture left an entitlement row';
  UPDATE public.orders
  SET amount_cents = 400,
      solidgate_refunded_amount_cents = 100,
      solidgate_payment_status = 'refunded'
  WHERE id = v_owner.order_db_id::UUID;
  ASSERT NOT public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2026-07-28T12:00:00Z'
  ), 'partially refunded main order received browser entitlement';

  -- Same-order revocation and terminal order tombstones always win.
  UPDATE public.orders
  SET amount_cents = 500,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'settle_ok'
  WHERE id = v_owner.order_db_id::UUID;
  ASSERT public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2026-07-28T12:00:00Z'
  ), 'active entitlement fixture could not be restored';
  UPDATE public.entitlements
  SET status = 'canceled', revoked_at = NOW()
  WHERE payment_environment = 'sandbox'
    AND user_id = '23000000-0000-4000-8000-000000000010'
    AND product_slug = 'BRAND_000000_SUB';
  ASSERT NOT public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2035-01-01T00:00:00Z'
  ), 'same-order revocation tombstone was reactivated';
  DELETE FROM public.entitlements
  WHERE payment_environment = 'sandbox'
    AND user_id = '23000000-0000-4000-8000-000000000010'
    AND product_slug = 'BRAND_000000_SUB';
  UPDATE public.orders
  SET status = 'canceled'
  WHERE id = v_owner.order_db_id::UUID;
  ASSERT NOT public.grant_solidgate_main_entitlement(
    'sandbox', v_owner.order_db_id::UUID,
    '23000000-0000-4000-8000-000000000010',
    'BRAND_000000_SUB', 'sub-round2-main', 500,
    '2035-01-01T00:00:00Z'
  ), 'terminal main order was granted without an entitlement tombstone';
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox'
      AND user_id = '23000000-0000-4000-8000-000000000010'
      AND product_slug = 'BRAND_000000_SUB'
  ), 'terminal order race left active access';

  PERFORM extensions.dblink_disconnect('round2-main-owner');
  PERFORM extensions.dblink_disconnect('round2-main-follower');
  PERFORM extensions.dblink_disconnect('round2-main-direct');
  RAISE NOTICE 'MAIN CHECKOUT IDENTITY/BUILDER CONCURRENCY SCENARIOS PASSED';
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-main-owner');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-main-follower');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-main-direct');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE;
END $$;

DELETE FROM public.entitlements
WHERE payment_environment = 'sandbox'
  AND user_id = '23000000-0000-4000-8000-000000000010';
DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND session_id IN (
    '23000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000002',
    '23000000-0000-4000-8000-000000000003'
  );
DELETE FROM public.sessions
WHERE id IN (
  '23000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000002',
  '23000000-0000-4000-8000-000000000003'
);
DELETE FROM auth.users
WHERE id = '23000000-0000-4000-8000-000000000010';

-- ── PWA order identity, mode, form cache, and saved-card fence ─────────────
-- Cleanup precedes every dblink transaction so rerunning after a failed later
-- assertion cannot adopt a provider identity committed by the prior run.
DELETE FROM public.entitlements
WHERE payment_environment = 'sandbox'
  AND user_id = '22000000-0000-4000-8000-000000000001';
DELETE FROM public.solidgate_pwa_purchase_states
WHERE payment_environment = 'sandbox'
  AND user_id = '22000000-0000-4000-8000-000000000001';
DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND user_id = '22000000-0000-4000-8000-000000000001';

INSERT INTO auth.users (id, email)
VALUES (
  '22000000-0000-4000-8000-000000000001',
  'solidgate-round2-pwa@example.invalid'
)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_database TEXT := pg_catalog.current_database();
  v_first RECORD;
  v_follower RECORD;
  v_takeover RECORD;
  v_form RECORD;
  v_cached RECORD;
  v_guarded RECORD;
  v_direct_first RECORD;
  v_action RECORD;
  v_conflict RECORD;
  v_addon RECORD;
  v_addon_retry RECORD;
  v_refund_retry RECORD;
  v_legacy_recovery RECORD;
  v_legacy_follower RECORD;
  v_error TEXT;
  v_busy INTEGER;
  v_count INTEGER;
  v_owner_token UUID := '22000000-0000-4000-8000-000000000011';
  v_follower_token UUID := '22000000-0000-4000-8000-000000000012';
  v_takeover_token UUID := '22000000-0000-4000-8000-000000000013';
  v_form_token UUID := '22000000-0000-4000-8000-000000000014';
  v_wrong_token UUID := '22000000-0000-4000-8000-000000000015';
  v_guard_token UUID := '22000000-0000-4000-8000-000000000016';
  v_direct_follower_token UUID := '22000000-0000-4000-8000-000000000017';
  v_addon_token UUID := '22000000-0000-4000-8000-000000000018';
  v_action_token UUID := '22000000-0000-4000-8000-000000000019';
  v_direct_builder_token UUID := '22000000-0000-4000-8000-000000000020';
  v_refund_retry_token UUID := '22000000-0000-4000-8000-000000000021';
  v_addon_retry_token UUID := '22000000-0000-4000-8000-000000000022';
  v_legacy_recovery_token UUID := '22000000-0000-4000-8000-000000000023';
  v_conflict_token UUID := '22000000-0000-4000-8000-000000000024';
  v_ultra_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto3_bundle_all',
    'locale', 'en'
  );
  v_pdf5_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto5_pdf',
    'locale', 'en'
  );
  v_soul_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto3_bundle_1',
    'locale', 'en'
  );
  v_addon_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto2_addon_weekly',
    'price_id', 'price-round2-pwa-usd'
  );
  v_action_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto3_bundle_3',
    'locale', 'en'
  );
  v_conflict_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto4_pdf',
    'locale', 'en'
  );
  v_legacy_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-22000000-0000-4000-8000-000000000001',
    'product_slug', 'oto6_pdf',
    'locale', 'en'
  );
  v_merchant_data JSONB := jsonb_build_object(
    'merchant', 'round2-merchant',
    'paymentIntent', 'round2-intent',
    'signature', 'round2-signature'
  );
BEGIN
  PERFORM extensions.dblink_connect(
    'round2-pwa-owner',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_connect(
    'round2-pwa-follower',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_connect(
    'round2-pwa-direct',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );

  -- Two independent RPC transactions serialize on the account/product key.
  -- The follower observes the committed identity and receives no provider lease.
  PERFORM extensions.dblink_exec('round2-pwa-owner', 'BEGIN');
  SELECT result.* INTO STRICT v_first
  FROM extensions.dblink(
    'round2-pwa-owner',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new,
               should_build, should_submit, needs_reconcile,
               claim_token::TEXT
        FROM public.open_solidgate_pwa_purchase_v2(
          'sandbox',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'oto3_bundle_all',
          'BRANDBUNDLE_000000_PDF',
          3000,
          'usd',
          %L::JSONB,
          'saved_card',
          %L::UUID,
          'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
        )
      $query$,
      v_ultra_metadata::TEXT,
      v_owner_token::TEXT
    )
  ) AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    should_submit BOOLEAN,
    needs_reconcile BOOLEAN,
    claim_token TEXT
  );
  ASSERT v_first.is_new AND v_first.should_submit
    AND NOT v_first.should_build AND NOT v_first.needs_reconcile
    AND v_first.claim_token::UUID = v_owner_token,
    'first PWA opener did not exclusively own saved-card submission';

  PERFORM extensions.dblink_send_query(
    'round2-pwa-follower',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id,
               bound_tracking_metadata::TEXT, is_new,
               should_build, should_submit, needs_reconcile,
               claim_token::TEXT
        FROM public.open_solidgate_pwa_purchase_v2(
          'sandbox',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'oto3_bundle_all',
          'BRANDBUNDLE_000000_PDF',
          3000,
          'usd',
          %L::JSONB,
          'saved_card',
          %L::UUID,
          'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
        )
      $query$,
      v_ultra_metadata::TEXT,
      v_follower_token::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-pwa-follower') INTO v_busy;
  ASSERT v_busy = 1, 'concurrent PWA follower did not wait on the opener lock';

  PERFORM extensions.dblink_exec('round2-pwa-owner', 'COMMIT');
  SELECT result.* INTO STRICT v_follower
  FROM extensions.dblink_get_result('round2-pwa-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    bound_tracking_metadata TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    should_submit BOOLEAN,
    needs_reconcile BOOLEAN,
    claim_token TEXT
  );
  ASSERT v_follower.solidgate_order_id = v_first.solidgate_order_id
    AND NOT v_follower.is_new
    AND NOT v_follower.should_build
    AND NOT v_follower.should_submit
    AND NOT v_follower.needs_reconcile
    AND v_follower.claim_token IS NULL,
    'PWA follower received a second action lease';
  ASSERT NOT (v_follower.bound_tracking_metadata::JSONB ? 'utm_source'),
    'late optional UTM drift replaced the immutable order metadata';

  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND user_id = '22000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDBUNDLE_000000_PDF';
  ASSERT v_count = 1, format('concurrent PWA open produced %s rows', v_count);

  -- Mode is immutable for an existing provider identity.
  BEGIN
    PERFORM 1
    FROM public.open_solidgate_pwa_purchase_v2(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      3000,
      'usd',
      v_ultra_metadata,
      'hosted_form',
      v_follower_token,
      'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
    );
    RAISE EXCEPTION 'PWA purchase mode changed on a live order';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- An uncertain PWA identity cannot be updated out of the guard/opener scope,
  -- nor may a direct writer replace its originally bound metadata.
  BEGIN
    UPDATE public.orders
    SET psp = 'stripe'
    WHERE id = v_first.order_db_id::UUID;
    RAISE EXCEPTION 'PWA order escaped the guard through a PSP rebind';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%PSP identity is immutable%',
      format('unexpected PWA identity-rebind rejection: %s', SQLERRM);
  END;
  BEGIN
    UPDATE public.orders
    SET tracking_metadata = tracking_metadata || '{"utm_source":"rewritten"}'::JSONB
    WHERE id = v_first.order_db_id::UUID;
    RAISE EXCEPTION 'direct writer replaced immutable PWA metadata';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM LIKE '%order binding is immutable%',
      format('unexpected PWA metadata-rebind rejection: %s', SQLERRM);
  END;
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_first.order_db_id::UUID
      AND psp = 'solidgate'
      AND tracking_metadata = v_ultra_metadata
  ), 'rejected PWA rebind still changed the uncertain order';

  -- Only an expired owner yields a reconcile-only claim on the same id.
  UPDATE public.solidgate_pwa_purchase_states
  SET claim_started_at = NOW() - INTERVAL '121 seconds'
  WHERE payment_environment = 'sandbox'
    AND user_id = '22000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDBUNDLE_000000_PDF';
  SELECT result.* INTO STRICT v_takeover
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    3000,
    'usd',
    v_ultra_metadata,
    'saved_card',
    v_takeover_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_takeover.solidgate_order_id = v_first.solidgate_order_id
    AND NOT v_takeover.is_new
    AND NOT v_takeover.should_build
    AND NOT v_takeover.should_submit
    AND v_takeover.needs_reconcile
    AND v_takeover.claim_token = v_takeover_token,
    'expired PWA saved-card lease did not reconcile the same provider id';
  ASSERT NOT public.resume_solidgate_pwa_submission_after_absent_reconcile(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_first.order_db_id::UUID,
    v_first.solidgate_order_id,
    3000,
    'usd',
    v_owner_token
  ), 'displaced PWA owner resumed after takeover';
  ASSERT public.resume_solidgate_pwa_submission_after_absent_reconcile(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_first.order_db_id::UUID,
    v_first.solidgate_order_id,
    3000,
    'usd',
    v_takeover_token
  ), 'current PWA reconcile owner could not resume the same id';
  ASSERT NOT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_first.order_db_id::UUID,
    v_first.solidgate_order_id,
    3000,
    'usd',
    v_owner_token,
    'terminal_failure',
    'declined',
    0,
    NULL,
    NULL
  ), 'displaced PWA owner published a terminal result';
  BEGIN
    PERFORM public.record_solidgate_pwa_submission_result(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_first.order_db_id::UUID,
      v_first.solidgate_order_id,
      3000,
      'usd',
      v_takeover_token,
      'terminal_failure',
      'request_rejected',
      3000,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'non-zero terminal PWA result retired an attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_solidgate_pwa_submission_result(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_first.order_db_id::UUID,
      v_first.solidgate_order_id,
      3000,
      'usd',
      v_takeover_token,
      'terminal_failure',
      'request_rejected',
      0,
      'contradictory-subscription',
      NULL
    );
    RAISE EXCEPTION 'request-rejected PWA result with a subscription retired an attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_solidgate_pwa_submission_result(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_first.order_db_id::UUID,
      v_first.solidgate_order_id,
      3000,
      'usd',
      v_takeover_token,
      'terminal_failure',
      'request_rejected',
      0,
      NULL,
      'https://verify.example.invalid/contradiction'
    );
    RAISE EXCEPTION 'request-rejected PWA result with a verify URL retired an attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_first.order_db_id::UUID,
    v_first.solidgate_order_id,
    3000,
    'usd',
    v_takeover_token,
    'terminal_failure',
    'request_rejected',
    0,
    NULL,
    NULL
  ), 'current PWA owner could not publish exact no-order request rejection';
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_first.order_db_id::UUID,
    v_first.solidgate_order_id,
    3000,
    'usd',
    v_takeover_token,
    'terminal_failure',
    'request_rejected',
    0,
    NULL,
    NULL
  ), 'identical PWA request rejection was not idempotent';
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_first.order_db_id::UUID
      AND status = 'failed'
      AND amount_cents = 0
      AND solidgate_original_amount_cents = 3000
      AND solidgate_payment_status = 'request_rejected'
  ), 'PWA request rejection did not preserve original gross';

  -- Exact terminal zero-net failure permits one next identity and a mode change.
  SELECT result.* INTO STRICT v_form
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    3000,
    'usd',
    v_ultra_metadata,
    'hosted_form',
    v_form_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_form.solidgate_order_id =
      'u-22000000-0000-4000-8000-000000000001:oto3_bundle_all:2'
    AND v_form.is_new
    AND v_form.should_build
    AND NOT v_form.should_submit
    AND NOT v_form.needs_reconcile
    AND v_form.claim_token = v_form_token,
    'PWA terminal retry did not allocate exactly one hosted-form attempt';
  BEGIN
    PERFORM public.finalize_solidgate_pwa_form(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_form.order_db_id,
      v_form.solidgate_order_id,
      3000,
      'usd',
      v_wrong_token,
      v_merchant_data
    );
    RAISE EXCEPTION 'stale PWA form builder published merchant data';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  ASSERT public.finalize_solidgate_pwa_form(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_form.order_db_id,
    v_form.solidgate_order_id,
    3000,
    'usd',
    v_form_token,
    v_merchant_data
  ) = v_merchant_data, 'current PWA form builder could not publish';
  SELECT result.* INTO STRICT v_cached
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    3000,
    'usd',
    v_ultra_metadata,
    'hosted_form',
    v_follower_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_cached.solidgate_order_id = v_form.solidgate_order_id
    AND v_cached.merchant_data = v_merchant_data
    AND NOT v_cached.should_build
    AND NOT v_cached.should_submit
    AND NOT v_cached.needs_reconcile
    AND v_cached.claim_token IS NULL,
    'cached PWA merchant data exposed a second owner';
  BEGIN
    PERFORM 1
    FROM public.open_solidgate_pwa_purchase_v2(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      3000,
      'usd',
      jsonb_set(v_ultra_metadata, '{locale}', '"lt"'::JSONB),
      'hosted_form',
      v_follower_token,
      'solidgate-round2-pwa@example.invalid', 'lt', NULL, 'auth_settle'
    );
    RAISE EXCEPTION 'canonical PWA locale binding changed on replay';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A fully refunded historical attempt no longer represents payable money.
  -- Its old amount/currency/locale remain immutable history and must not pin a
  -- later purchase to stale pricing.
  UPDATE public.orders
  SET status = 'refunded',
      amount_cents = 0,
      solidgate_payment_status = 'refunded'
  WHERE id = v_form.order_db_id;
  SELECT result.* INTO STRICT v_refund_retry
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    3500,
    'eur',
    jsonb_set(v_ultra_metadata, '{locale}', '"lt"'::JSONB),
    'saved_card',
    v_refund_retry_token,
    'solidgate-round2-pwa@example.invalid', 'lt', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_refund_retry.solidgate_order_id =
      'u-22000000-0000-4000-8000-000000000001:oto3_bundle_all:3'
    AND v_refund_retry.is_new
    AND v_refund_retry.should_submit
    AND NOT v_refund_retry.should_build
    AND v_refund_retry.bound_amount_cents = 3500
    AND v_refund_retry.bound_currency = 'eur',
    'refunded PWA history blocked a new purchase at changed pricing';

  -- RPC-first versus a rolling count+insert writer: the direct statement waits
  -- on the same key, then is rejected after the RPC identity commits.
  PERFORM extensions.dblink_exec('round2-pwa-owner', 'BEGIN');
  SELECT result.* INTO STRICT v_guarded
  FROM extensions.dblink(
    'round2-pwa-owner',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new,
               should_build, should_submit, needs_reconcile,
               claim_token::TEXT
        FROM public.open_solidgate_pwa_purchase_v2(
          'sandbox',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'oto5_pdf',
          'BRANDPDF5_000000_PDF',
          3000,
          'usd',
          %L::JSONB,
          'saved_card',
          %L::UUID,
          'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
        )
      $query$,
      v_pdf5_metadata::TEXT,
      v_guard_token::TEXT
    )
  ) AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    should_submit BOOLEAN,
    needs_reconcile BOOLEAN,
    claim_token TEXT
  );
  PERFORM extensions.dblink_send_query(
    'round2-pwa-direct',
    format(
      $query$
        INSERT INTO public.orders (
          psp, payment_environment, solidgate_order_id, user_id, status,
          amount_cents, currency, product_name, product_slug,
          solidgate_customer_email, solidgate_checkout_locale,
          solidgate_payment_action, tracking_metadata
        ) VALUES (
          'solidgate',
          'sandbox',
          'u-22000000-0000-4000-8000-000000000001:oto5_pdf:2',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'pending',
          3000,
          'usd',
          'BRANDPDF5_000000_PDF',
          'BRANDPDF5_000000_PDF',
          'solidgate-round2-pwa@example.invalid',
          'en',
          'auth_settle',
          %L::JSONB
        )
        RETURNING solidgate_order_id
      $query$,
      v_pdf5_metadata::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-pwa-direct') INTO v_busy;
  ASSERT v_busy = 1, 'rolling PWA direct writer did not wait on the RPC lock';
  PERFORM extensions.dblink_exec('round2-pwa-owner', 'COMMIT');
  PERFORM result.solidgate_order_id
  FROM extensions.dblink_get_result('round2-pwa-direct', FALSE)
    AS result(solidgate_order_id TEXT);
  v_error := extensions.dblink_error_message('round2-pwa-direct');
  ASSERT v_error LIKE '%already payable or uncertain%',
    format('rolling PWA writer was not rejected after RPC commit: %s', v_error);
  SELECT COUNT(*) INTO v_count
  FROM public.orders
  WHERE payment_environment = 'sandbox'
    AND user_id = '22000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDPDF5_000000_PDF';
  ASSERT v_count = 1, format('RPC/direct PWA race produced %s rows', v_count);

  -- Asynchronous dblink statements can leave one protocol result to be drained.
  -- Reconnect both async sessions before reusing them for the reverse race.
  PERFORM extensions.dblink_disconnect('round2-pwa-direct');
  PERFORM extensions.dblink_connect(
    'round2-pwa-direct',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );
  PERFORM extensions.dblink_disconnect('round2-pwa-follower');
  PERFORM extensions.dblink_connect(
    'round2-pwa-follower',
    format(
      '%s dbname=%s',
      pg_catalog.current_setting('round2.dblink_conn'),
      v_database
    )
  );

  -- A captured result stays pending for confirm/webhook fulfillment and cannot
  -- yield another submitter or order identity in the gap.
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto5_pdf',
    'BRANDPDF5_000000_PDF',
    v_guarded.order_db_id::UUID,
    v_guarded.solidgate_order_id,
    3000,
    'usd',
    v_guard_token,
    'captured',
    'settle_ok',
    3000,
    NULL,
    NULL
  ), 'captured PWA one-time result was not recorded';
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_guarded.order_db_id::UUID
      AND status = 'pending'
      AND amount_cents = 3000
      AND solidgate_payment_status = 'settle_ok'
  ), 'captured PWA result bypassed confirm or changed the gross';
  SELECT result.* INTO STRICT v_follower
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto5_pdf',
    'BRANDPDF5_000000_PDF',
    3000,
    'usd',
    v_pdf5_metadata,
    'saved_card',
    v_follower_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_follower.solidgate_order_id = v_guarded.solidgate_order_id
    AND NOT v_follower.is_new
    AND NOT v_follower.should_build
    AND NOT v_follower.should_submit
    AND NOT v_follower.needs_reconcile
    AND v_follower.last_result_kind = 'captured'
    AND v_follower.last_result_net_amount_cents = v_follower.bound_amount_cents,
    'captured-but-unfulfilled PWA order exposed another action';

  -- Direct-writer-first is also safe: after commit the RPC adopts that exact
  -- identity as an ownerless reconcile state, never as a second submitter.
  PERFORM extensions.dblink_exec('round2-pwa-direct', 'BEGIN');
  PERFORM extensions.dblink_exec(
    'round2-pwa-direct',
    format(
      $query$
        INSERT INTO public.orders (
          psp, payment_environment, solidgate_order_id, user_id, status,
          amount_cents, currency, product_name, product_slug,
          solidgate_customer_email, solidgate_checkout_locale,
          solidgate_payment_action, tracking_metadata
        ) VALUES (
          'solidgate',
          'sandbox',
          'u-22000000-0000-4000-8000-000000000001:oto3_bundle_1:1',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'pending',
          2000,
          'usd',
          'BRANDBUNDLE1_000000_PDF',
          'BRANDBUNDLE1_000000_PDF',
          'solidgate-round2-pwa@example.invalid',
          'en',
          'auth_settle',
          %L::JSONB
        )
      $query$,
      v_soul_metadata::TEXT
    )
  );
  PERFORM extensions.dblink_send_query(
    'round2-pwa-follower',
    format(
      $query$
        SELECT order_db_id::TEXT, solidgate_order_id, is_new,
               should_build, should_submit, needs_reconcile,
               claim_token::TEXT
        FROM public.open_solidgate_pwa_purchase_v2(
          'sandbox',
          '22000000-0000-4000-8000-000000000001'::UUID,
          'oto3_bundle_1',
          'BRANDBUNDLE1_000000_PDF',
          2000,
          'usd',
          %L::JSONB,
          'hosted_form',
          %L::UUID,
          'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
        )
      $query$,
      v_soul_metadata::TEXT,
      v_direct_follower_token::TEXT
    )
  );
  PERFORM pg_catalog.pg_sleep(0.15);
  SELECT extensions.dblink_is_busy('round2-pwa-follower') INTO v_busy;
  ASSERT v_busy = 1, 'PWA RPC did not wait on a rolling direct writer';
  PERFORM extensions.dblink_exec('round2-pwa-direct', 'COMMIT');
  SELECT result.* INTO STRICT v_direct_first
  FROM extensions.dblink_get_result('round2-pwa-follower') AS result(
    order_db_id TEXT,
    solidgate_order_id TEXT,
    is_new BOOLEAN,
    should_build BOOLEAN,
    should_submit BOOLEAN,
    needs_reconcile BOOLEAN,
    claim_token TEXT
  );
  ASSERT v_direct_first.solidgate_order_id =
      'u-22000000-0000-4000-8000-000000000001:oto3_bundle_1:1'
    AND NOT v_direct_first.is_new
    AND NOT v_direct_first.should_build
    AND NOT v_direct_first.should_submit
    AND NOT v_direct_first.needs_reconcile
    AND v_direct_first.claim_token IS NULL,
    'RPC follower acquired ownership of a rolling direct-writer order';
  UPDATE public.solidgate_pwa_purchase_states
  SET claim_started_at = NOW() - INTERVAL '31 seconds'
  WHERE payment_environment = 'sandbox'
    AND user_id = '22000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDBUNDLE1_000000_PDF';
  SELECT result.* INTO STRICT v_direct_first
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF',
    2000,
    'usd',
    v_soul_metadata,
    'hosted_form',
    v_direct_builder_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_direct_first.should_build
    AND NOT v_direct_first.should_submit
    AND NOT v_direct_first.needs_reconcile
    AND v_direct_first.claim_token = v_direct_builder_token,
    'rolling hosted-form order did not recover as a builder-only claim';

  -- The card API may expose verify_url while the nested order still says
  -- processing. Persist that challenge without inventing a 3ds_verify status.
  SELECT result.* INTO STRICT v_action
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_3',
    'BRANDBUNDLE3_000000_PDF',
    2000,
    'usd',
    v_action_metadata,
    'saved_card',
    v_action_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto3_bundle_3',
    'BRANDBUNDLE3_000000_PDF',
    v_action.order_db_id,
    v_action.solidgate_order_id,
    2000,
    'usd',
    v_action_token,
    'requires_action',
    'processing',
    2000,
    NULL,
    'https://verify.example.invalid/round2'
  ), 'processing PWA order did not persist its verify URL';
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_action.order_db_id
      AND status = 'pending'
      AND solidgate_payment_status = 'processing'
      AND solidgate_verify_url = 'https://verify.example.invalid/round2'
  ), 'PWA 3DS challenge state was not durable';

  -- If the current signed status carries conflicting verify_url/verify_link
  -- values, the route publishes a non-actionable 3ds_verify observation. The
  -- database must accept that exact fail-closed shape and erase both cached
  -- copies so a follower cannot resurrect an older ACS redirect.
  SELECT result.* INTO STRICT v_conflict
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto4_pdf',
    'BRANDPDF4_000000_PDF',
    2000,
    'usd',
    v_conflict_metadata,
    'saved_card',
    v_conflict_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  UPDATE public.orders
  SET solidgate_verify_url = 'https://verify.example.invalid/stale-order-copy'
  WHERE id = v_conflict.order_db_id;
  UPDATE public.solidgate_pwa_purchase_states
  SET last_result_verify_url = 'https://verify.example.invalid/stale-state-copy'
  WHERE payment_environment = 'sandbox'
    AND user_id = '22000000-0000-4000-8000-000000000001'
    AND product_slug = 'BRANDPDF4_000000_PDF';
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto4_pdf',
    'BRANDPDF4_000000_PDF',
    v_conflict.order_db_id,
    v_conflict.solidgate_order_id,
    2000,
    'usd',
    v_conflict_token,
    'pending',
    '3ds_verify',
    2000,
    NULL,
    NULL
  ), 'PWA conflicting 3DS aliases did not publish fail-closed pending state';
  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_conflict.order_db_id
      AND status = 'pending'
      AND solidgate_payment_status = '3ds_verify'
      AND solidgate_verify_url IS NULL
  ), 'PWA conflicting 3DS aliases left the cached order ACS URL reusable';
  ASSERT EXISTS (
    SELECT 1
    FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = '22000000-0000-4000-8000-000000000001'
      AND product_slug = 'BRANDPDF4_000000_PDF'
      AND claim_kind IS NULL
      AND last_result_kind = 'pending'
      AND last_result_verify_url IS NULL
  ), 'PWA conflicting 3DS aliases left the cached state ACS URL reusable';

  -- Add-on capture is fenced too and requires a subscription identity.
  SELECT result.* INTO STRICT v_addon
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    4900,
    'usd',
    v_addon_metadata,
    'saved_card',
    v_addon_token,
    'solidgate-round2-pwa@example.invalid', 'en',
    'product-round2-pwa-addon', 'auth_settle'
  ) AS result;
  BEGIN
    PERFORM public.record_solidgate_pwa_submission_result(
      'sandbox',
      '22000000-0000-4000-8000-000000000001',
      'oto2_addon_weekly',
      'BRANDADDON_000000_SUB',
      v_addon.order_db_id,
      v_addon.solidgate_order_id,
      4900,
      'usd',
      v_addon_token,
      'captured',
      'settle_ok',
      4900,
      NULL,
      NULL
    );
    RAISE EXCEPTION 'captured add-on omitted its subscription identity';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_addon.order_db_id,
    v_addon.solidgate_order_id,
    4900,
    'usd',
    v_addon_token,
    'captured',
    'settle_ok',
    4900,
    'sub-round2-pwa',
    NULL
  ), 'captured PWA add-on result was not recorded';
  UPDATE public.orders
  SET status = 'active'
  WHERE id = v_addon.order_db_id;
  ASSERT NOT public.record_solidgate_pwa_submission_result(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_addon.order_db_id,
    v_addon.solidgate_order_id,
    4900,
    'usd',
    v_addon_token,
    'captured',
    'settle_ok',
    4900,
    'sub-round2-pwa',
    NULL
  ), 'record RPC ignored a webhook/confirm winner';

  -- Cancellation closes the subscription attempt. A resubscribe gets N+1 and
  -- binds the then-current catalog price instead of comparing against history.
  UPDATE public.orders
  SET status = 'canceled'
  WHERE id = v_addon.order_db_id;
  SELECT result.* INTO STRICT v_addon_retry
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    5900,
    'eur',
    jsonb_set(v_addon_metadata, '{price_id}', '"price-round2-pwa-eur-new"'::JSONB),
    'saved_card',
    v_addon_retry_token,
    'solidgate-round2-pwa@example.invalid', 'en',
    'product-round2-pwa-addon', 'auth_settle'
  ) AS result;
  ASSERT v_addon_retry.solidgate_order_id =
      'u-22000000-0000-4000-8000-000000000001:oto2_addon_weekly:2'
    AND v_addon_retry.is_new
    AND v_addon_retry.should_submit
    AND v_addon_retry.bound_amount_cents = 5900
    AND v_addon_retry.bound_currency = 'eur',
    'canceled add-on could not resubscribe at its current price';

  -- Rolling versions could leave an ambiguous provider exception as
  -- failed/gross/creating. The atomic opener adopts that exact id as a
  -- reconcile-only claim; it never mints N+1 or submits before absence proof.
  -- This direct writer represents a separate request/transaction, so clear the
  -- transaction-local add-on product context left by the preceding RPC.
  PERFORM pg_catalog.set_config('app.solidgate_product_id', '', TRUE);
  INSERT INTO public.orders (
    psp, payment_environment, solidgate_order_id, user_id, status,
    amount_cents, currency, product_name, product_slug,
    solidgate_payment_status, solidgate_customer_email,
    solidgate_checkout_locale, solidgate_payment_action, tracking_metadata
  ) VALUES (
    'solidgate',
    'sandbox',
    'u-22000000-0000-4000-8000-000000000001:oto6_pdf:1',
    '22000000-0000-4000-8000-000000000001',
    'failed',
    2500,
    'usd',
    'BRANDPDF6_000000_PDF',
    'BRANDPDF6_000000_PDF',
    'creating',
    'solidgate-round2-pwa@example.invalid',
    'en',
    'auth_settle',
    v_legacy_metadata
  );
  SELECT result.* INTO STRICT v_legacy_recovery
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto6_pdf',
    'BRANDPDF6_000000_PDF',
    2500,
    'usd',
    v_legacy_metadata,
    'saved_card',
    v_legacy_recovery_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_legacy_recovery.solidgate_order_id =
      'u-22000000-0000-4000-8000-000000000001:oto6_pdf:1'
    AND NOT v_legacy_recovery.is_new
    AND NOT v_legacy_recovery.should_submit
    AND v_legacy_recovery.needs_reconcile
    AND v_legacy_recovery.claim_token = v_legacy_recovery_token
    AND v_legacy_recovery.bound_order_status = 'pending',
    'legacy failed/gross/creating row was not adopted for same-id reconciliation';
  SELECT result.* INTO STRICT v_legacy_follower
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    '22000000-0000-4000-8000-000000000001',
    'oto6_pdf',
    'BRANDPDF6_000000_PDF',
    2500,
    'usd',
    v_legacy_metadata,
    'saved_card',
    v_follower_token,
    'solidgate-round2-pwa@example.invalid', 'en', NULL, 'auth_settle'
  ) AS result;
  ASSERT v_legacy_follower.solidgate_order_id = v_legacy_recovery.solidgate_order_id
    AND NOT v_legacy_follower.should_submit
    AND NOT v_legacy_follower.needs_reconcile
    AND v_legacy_follower.claim_token IS NULL,
    'legacy recovery exposed a second reconcile or submit owner';

  PERFORM extensions.dblink_disconnect('round2-pwa-owner');
  PERFORM extensions.dblink_disconnect('round2-pwa-follower');
  PERFORM extensions.dblink_disconnect('round2-pwa-direct');
  RAISE NOTICE 'PWA OPEN/MODE/FORM/SUBMISSION CONCURRENCY SCENARIOS PASSED';
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-pwa-owner');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-pwa-follower');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    PERFORM extensions.dblink_disconnect('round2-pwa-direct');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RAISE;
END $$;

DELETE FROM public.solidgate_pwa_purchase_states
WHERE payment_environment = 'sandbox'
  AND user_id = '22000000-0000-4000-8000-000000000001';
DELETE FROM public.orders
WHERE payment_environment = 'sandbox'
  AND user_id = '22000000-0000-4000-8000-000000000001';
DELETE FROM auth.users
WHERE id = '22000000-0000-4000-8000-000000000001';

DELETE FROM public.solidgate_webhook_events
WHERE environment = 'sandbox'
  AND event_id LIKE 'round2-%';

\echo ALL ROUND-2 SOLIDGATE CONCURRENCY SCENARIOS PASSED
