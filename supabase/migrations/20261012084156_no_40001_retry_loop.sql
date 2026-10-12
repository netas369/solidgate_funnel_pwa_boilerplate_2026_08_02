-- Stale-revision and lost-ownership errors now use SQLSTATE PT409, not 40001.
--
-- PostgREST before v16 retries any transaction that fails with 40001
-- (serialization_failure) and never gives up (PostgREST #3673, via
-- hasql-transaction). These errors are permanent: a stale quiz revision never
-- becomes current again and a displaced Solidgate builder never regains its
-- lease. Each one therefore looped inside the database until PostgREST
-- restarted, holding a pool connection and leaving the HTTP request hanging.
--
-- PostgREST answers PT409 with HTTP 409 and does not retry it. Messages are
-- unchanged; the app matches QUIZ_STALE_REVISION by message text and treats
-- the Solidgate errors as generic failures, so no caller depends on the code.
--
-- Bodies are identical to 00001_baseline.sql apart from the ERRCODE.
-- CREATE OR REPLACE keeps the existing owner, REVOKEs and GRANTs.

CREATE OR REPLACE FUNCTION public.save_quiz_session_progress(
  p_session_id UUID,
  p_expected_revision INTEGER,
  p_quiz_answers JSONB,
  p_current_step_id TEXT,
  p_email TEXT,
  p_locale TEXT,
  p_consent_given_at TIMESTAMPTZ,
  p_consent_version TEXT,
  p_marketing_consent BOOLEAN,
  p_event_id UUID,
  p_event_type TEXT,
  p_event_step_number INTEGER,
  p_event_metadata JSONB,
  -- {"viewed":[ids],"answered":[ids],"skipped":[ids]} -- step ids only, never
  -- client timestamps. See quiz_merge_step_activity() for the merge contract.
  p_step_activity JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
  v_existing public.sessions%ROWTYPE;
  v_now TIMESTAMPTZ := now();   -- one stamp for the whole call
BEGIN
  UPDATE public.sessions
  SET
    quiz_answers = p_quiz_answers,
    current_step_id = COALESCE(p_current_step_id, current_step_id),
    email = COALESCE(p_email, email),
    locale = COALESCE(p_locale, locale),
    consent_given_at = COALESCE(p_consent_given_at, consent_given_at),
    consent_version = COALESCE(p_consent_version, consent_version),
    marketing_consent = COALESCE(p_marketing_consent, marketing_consent),
    -- step_activity on the RIGHT-hand side is the PRE-update value, so the
    -- first-view COALESCE and the view increment both see the stored entry.
    -- Keeping the merge inside this same revision-guarded UPDATE is what
    -- removes the read-modify-write window; do not lift it into a second
    -- statement.
    step_activity = public.quiz_merge_step_activity(
      step_activity, p_step_activity, v_now
    ),
    welcome_email_pending = CASE
      WHEN p_email IS NOT NULL THEN true
      ELSE welcome_email_pending
    END,
    revision = revision + 1,
    updated_at = v_now
  WHERE id = p_session_id
    AND status = 'active'
    AND revision = p_expected_revision
  RETURNING * INTO v_session;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM public.sessions
    WHERE id = p_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'QUIZ_SESSION_NOT_FOUND';
    END IF;

    IF v_existing.status <> 'active' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'QUIZ_SESSION_TERMINAL';
    END IF;

    -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
    RAISE EXCEPTION USING
      ERRCODE = 'PT409',
      MESSAGE = 'QUIZ_STALE_REVISION:' || v_existing.revision::TEXT;
  END IF;

  IF p_event_id IS NOT NULL AND p_event_type IS NOT NULL THEN
    INSERT INTO public.funnel_events (
      event_id,
      session_id,
      event_type,
      step_number,
      metadata,
      occurred_at
    ) VALUES (
      p_event_id,
      p_session_id,
      p_event_type,
      p_event_step_number,
      COALESCE(p_event_metadata, '{}'::JSONB),
      v_now
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'status', v_session.status,
    'revision', v_session.revision,
    'current_step_id', v_session.current_step_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_quiz_session(
  p_session_id UUID,
  p_expected_revision INTEGER,
  p_quiz_result JSONB,
  p_result_segment TEXT,
  p_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session
  FROM public.sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'QUIZ_SESSION_NOT_FOUND';
  END IF;

  IF v_session.status = 'completed' THEN
    RETURN jsonb_build_object(
      'id', v_session.id,
      'status', v_session.status,
      'revision', v_session.revision,
      'quiz_result', v_session.quiz_result,
      'result_segment', v_session.result_segment,
      'completed_at', v_session.completed_at
    );
  END IF;

  IF v_session.status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'QUIZ_SESSION_TERMINAL';
  END IF;

  IF v_session.revision <> p_expected_revision THEN
    -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
    RAISE EXCEPTION USING
      ERRCODE = 'PT409',
      MESSAGE = 'QUIZ_STALE_REVISION:' || v_session.revision::TEXT;
  END IF;

  UPDATE public.sessions
  SET
    quiz_result = p_quiz_result,
    result_segment = p_result_segment,
    status = 'completed',
    current_step_id = 'results',
    completed_at = now(),
    updated_at = now(),
    revision = revision + 1
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  INSERT INTO public.funnel_events (
    event_id,
    session_id,
    event_type,
    metadata,
    occurred_at
  ) VALUES (
    p_event_id,
    p_session_id,
    'quiz_completed',
    jsonb_build_object('result_segment', p_result_segment),
    now()
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'id', v_session.id,
    'status', v_session.status,
    'revision', v_session.revision,
    'quiz_result', v_session.quiz_result,
    'result_segment', v_session.result_segment,
    'completed_at', v_session.completed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_main_checkout(
  p_payment_environment TEXT,
  p_session_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_builder_token UUID,
  p_merchant_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_main_checkout_states%ROWTYPE;
BEGIN
  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_session_id IS NULL
     OR p_offer_slug IS NULL
     OR p_offer_slug NOT IN (
       'trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'
     )
     OR p_product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_amount_cents IS DISTINCT FROM public.solidgate_main_checkout_amount(
          p_offer_slug,
          p_currency
        )
     OR p_builder_token IS NULL
     OR p_merchant_data IS NULL
     OR jsonb_typeof(p_merchant_data) <> 'object'
     OR jsonb_typeof(p_merchant_data -> 'merchant') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'paymentIntent') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'signature') <> 'string'
     OR NULLIF(BTRIM(p_merchant_data ->> 'merchant'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'paymentIntent'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'signature'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate main merchant data finalization'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_payment_environment || ':' || p_session_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.session_id IS DISTINCT FROM p_session_id
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(
          v_order.solidgate_order_id,
          LENGTH(p_session_id::TEXT || ':' || p_offer_slug || ':')
        ) IS DISTINCT FROM (p_session_id::TEXT || ':' || p_offer_slug || ':')
     OR SUBSTRING(
          v_order.solidgate_order_id
          FROM LENGTH(p_session_id::TEXT || ':' || p_offer_slug || ':') + 1
        ) !~ '^[1-9][0-9]{0,8}$'
     OR v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IN ('auth_failed', 'declined', 'void_ok')
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM p_session_id::TEXT
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug THEN
    RAISE EXCEPTION 'Solidgate main order changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  SELECT checkout.*
  INTO STRICT v_state
  FROM public.solidgate_main_checkout_states AS checkout
  WHERE checkout.payment_environment = p_payment_environment
    AND checkout.session_id = p_session_id
    AND checkout.product_slug = p_product_slug
  FOR UPDATE;

  IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.builder_token IS DISTINCT FROM p_builder_token THEN
    -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
    RAISE EXCEPTION 'Solidgate main checkout builder lost ownership'
      USING ERRCODE = 'PT409';
  END IF;

  IF v_state.merchant_data IS NULL THEN
    UPDATE public.solidgate_main_checkout_states AS checkout
    SET merchant_data = p_merchant_data,
        updated_at = NOW()
    WHERE checkout.payment_environment = p_payment_environment
      AND checkout.session_id = p_session_id
      AND checkout.product_slug = p_product_slug
    RETURNING checkout.* INTO v_state;
  ELSIF v_state.merchant_data IS DISTINCT FROM p_merchant_data THEN
    RAISE EXCEPTION 'Solidgate main checkout already finalized differently'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_solidgate_pwa_form(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID,
  p_merchant_data JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL
     OR p_merchant_data IS NULL
     OR jsonb_typeof(p_merchant_data) <> 'object'
     OR jsonb_typeof(p_merchant_data -> 'merchant') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'paymentIntent') <> 'string'
     OR jsonb_typeof(p_merchant_data -> 'signature') <> 'string'
     OR NULLIF(BTRIM(p_merchant_data ->> 'merchant'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'paymentIntent'), '') IS NULL
     OR NULLIF(BTRIM(p_merchant_data ->> 'signature'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA form finalization'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO STRICT v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO STRICT v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'hosted_form' THEN
    RAISE EXCEPTION 'Solidgate PWA form binding changed before finalization'
      USING ERRCODE = '23514';
  END IF;

  IF v_state.merchant_data IS NOT NULL THEN
    IF v_state.claim_token IS DISTINCT FROM p_claim_token
       OR v_state.merchant_data IS DISTINCT FROM p_merchant_data THEN
      -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
      RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
        USING ERRCODE = 'PT409';
    END IF;
    IF v_order.status IS DISTINCT FROM 'pending'
       OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating' THEN
      RAISE EXCEPTION 'Solidgate PWA form order changed after finalization'
        USING ERRCODE = 'PT409';
    END IF;
    RETURN v_state.merchant_data;
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind IS DISTINCT FROM 'build_form' THEN
    RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
      USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET merchant_data = p_merchant_data,
      claim_kind = NULL,
      claim_started_at = NULL,
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.purchase_mode = 'hosted_form'
    AND state.claim_token = p_claim_token
    AND state.claim_kind = 'build_form'
  RETURNING state.* INTO v_state;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA form builder lost ownership'
      USING ERRCODE = 'PT409';
  END IF;

  UPDATE public.orders AS candidate
  SET solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solidgate PWA form order changed during finalization'
      USING ERRCODE = 'PT409';
  END IF;

  RETURN v_state.merchant_data;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_solidgate_pwa_submission_result(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID,
  p_result_kind TEXT,
  p_provider_status TEXT,
  p_net_amount_cents INTEGER,
  p_subscription_id TEXT,
  p_verify_url TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL
     OR p_result_kind IS NULL
     OR p_result_kind NOT IN (
       'pending', 'requires_action', 'captured', 'terminal_failure'
     )
     OR NULLIF(BTRIM(p_provider_status), '') IS NULL
     OR p_net_amount_cents IS NULL
     OR p_net_amount_cents < 0 THEN
    RAISE EXCEPTION 'invalid Solidgate PWA submission result'
      USING ERRCODE = '22023';
  END IF;

  IF p_result_kind = 'terminal_failure' THEN
    -- `request_rejected` is admitted only from the route's claim-fenced,
    -- definite no-provider-order branch. The zero-net/subscription/verify-url
    -- checks below remain the database-side retirement fence.
    IF p_provider_status NOT IN (
         'auth_failed', 'declined', 'void_ok', 'request_rejected'
       )
       OR p_net_amount_cents <> 0
       OR p_subscription_id IS NOT NULL
       OR p_verify_url IS NOT NULL THEN
      RAISE EXCEPTION 'invalid terminal Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_result_kind = 'captured' THEN
    IF p_provider_status NOT IN ('settle_ok', 'partial_settled')
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NOT NULL
       OR (
         p_offer_slug = 'oto2_addon_weekly'
         AND NULLIF(BTRIM(p_subscription_id), '') IS NULL
       )
       OR (
         p_offer_slug <> 'oto2_addon_weekly'
         AND p_subscription_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'invalid captured Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_result_kind = 'requires_action' THEN
    -- /recurring may return a top-level verify_url while the nested order is
    -- still created/processing/auth_ok. 3ds_verify is not guaranteed until the
    -- buyer actually opens or completes the challenge.
    IF p_provider_status NOT IN ('created', 'processing', 'auth_ok', '3ds_verify')
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NULL
       OR p_verify_url !~ '^https://[^[:space:]]+$'
       OR (p_offer_slug <> 'oto2_addon_weekly' AND p_subscription_id IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid actionable Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- `3ds_verify` with no URL is a valid fail-closed observation when the
    -- provider's canonical and compatibility URL aliases conflict. Persisting
    -- it as pending clears any cached ACS URL without pretending the
    -- challenge is actionable.
    IF p_provider_status NOT IN (
         'created', 'processing', 'auth_ok', 'partial_settled', '3ds_verify'
       )
       OR p_net_amount_cents <> p_amount_cents
       OR p_verify_url IS NOT NULL
       OR (p_offer_slug <> 'oto2_addon_weekly' AND p_subscription_id IS NOT NULL) THEN
      RAISE EXCEPTION 'invalid pending Solidgate PWA submission result'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.id IS NULL OR v_state.order_db_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'saved_card' THEN
    RAISE EXCEPTION 'Solidgate PWA submission result binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- The same owner may retry after losing the RPC response, but only while the
  -- order still exactly reflects that owner's already-recorded result. Any
  -- webhook, confirm, or lease-takeover change returns false.
  IF v_state.claim_kind IS NULL
     AND v_state.claim_token = p_claim_token
     AND v_state.last_result_kind = p_result_kind
     AND v_state.last_result_net_amount_cents = p_net_amount_cents
     AND v_state.last_result_subscription_id IS NOT DISTINCT FROM p_subscription_id
     AND v_state.last_result_verify_url IS NOT DISTINCT FROM p_verify_url THEN
    IF p_result_kind = 'terminal_failure' THEN
      RETURN v_order.status = 'failed'
        AND v_order.amount_cents = 0
        AND v_order.solidgate_original_amount_cents = p_amount_cents
        AND v_order.solidgate_payment_status = p_provider_status;
    END IF;
    RETURN v_order.status = 'pending'
      AND v_order.amount_cents = p_amount_cents
      AND v_order.solidgate_payment_status = p_provider_status
      AND v_order.solidgate_subscription_id IS NOT DISTINCT FROM p_subscription_id
      AND v_order.solidgate_verify_url IS NOT DISTINCT FROM p_verify_url;
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind NOT IN ('submit_card', 'reconcile') THEN
    RETURN FALSE;
  END IF;

  UPDATE public.orders AS candidate
  SET status = CASE
        WHEN p_result_kind = 'terminal_failure' THEN 'failed'
        ELSE 'pending'
      END,
      amount_cents = CASE
        WHEN p_result_kind = 'terminal_failure' THEN 0
        ELSE p_amount_cents
      END,
      solidgate_original_amount_cents = p_amount_cents,
      solidgate_payment_status = p_provider_status,
      solidgate_subscription_id = p_subscription_id,
      solidgate_verify_url = p_verify_url,
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.amount_cents = p_amount_cents
    AND candidate.solidgate_original_amount_cents = p_amount_cents
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET claim_kind = NULL,
      claim_started_at = NULL,
      last_result_kind = p_result_kind,
      last_result_net_amount_cents = p_net_amount_cents,
      last_result_subscription_id = p_subscription_id,
      last_result_verify_url = p_verify_url,
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.purchase_mode = 'saved_card'
    AND state.claim_token = p_claim_token
    AND state.claim_kind IN ('submit_card', 'reconcile');

  IF NOT FOUND THEN
    -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
    RAISE EXCEPTION 'Solidgate PWA result fence changed during publication'
      USING ERRCODE = 'PT409';
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_solidgate_pwa_submission_after_absent_reconcile(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_order_db_id UUID,
  p_solidgate_order_id TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_expected_product TEXT;
  v_account_ref TEXT;
  v_expected_prefix TEXT;
BEGIN
  v_expected_product := public.solidgate_pwa_product_code(p_offer_slug);
  v_account_ref := 'u-' || p_user_id::TEXT;
  v_expected_prefix := v_account_ref || ':' || p_offer_slug || ':';

  IF p_payment_environment IS NULL
     OR p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR v_expected_product IS NULL
     OR p_product_slug IS DISTINCT FROM v_expected_product
     OR p_order_db_id IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents <= 0
     OR p_currency IS NULL
     OR p_currency !~ '^[a-z]{3}$'
     OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA reconcile claim'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;

  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;

  IF v_order.id IS NULL OR v_state.order_db_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR LOWER(v_order.currency) IS DISTINCT FROM p_currency
     OR v_order.solidgate_order_id IS DISTINCT FROM p_solidgate_order_id
     OR LEFT(v_order.solidgate_order_id, LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR SUBSTRING(v_order.solidgate_order_id FROM LENGTH(v_expected_prefix) + 1)
          !~ '^[1-9][0-9]{0,8}$'
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.tracking_metadata ->> 'session_id' IS DISTINCT FROM v_account_ref
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM p_offer_slug
     OR v_state.offer_slug IS DISTINCT FROM p_offer_slug
     OR v_state.order_db_id IS DISTINCT FROM p_order_db_id
     OR v_state.purchase_mode IS DISTINCT FROM 'saved_card' THEN
    RAISE EXCEPTION 'Solidgate PWA reconcile binding mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF v_order.status IS DISTINCT FROM 'pending'
     OR v_order.solidgate_payment_status IS DISTINCT FROM 'creating'
     OR v_order.solidgate_submission_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_token IS DISTINCT FROM p_claim_token
     OR v_state.claim_kind IS DISTINCT FROM 'reconcile'
     OR v_state.claim_started_at < NOW() - INTERVAL '120 seconds' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.solidgate_pwa_purchase_states AS state
  SET claim_kind = 'submit_card',
      claim_started_at = NOW(),
      updated_at = NOW()
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
    AND state.order_db_id = p_order_db_id
    AND state.claim_token = p_claim_token
    AND state.claim_kind = 'reconcile';

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.orders AS candidate
  SET solidgate_submission_started_at = NOW()
  WHERE candidate.id = p_order_db_id
    AND candidate.status = 'pending'
    AND candidate.solidgate_payment_status = 'creating'
    AND candidate.solidgate_submission_token = p_claim_token;

  IF NOT FOUND THEN
    -- PT409 (HTTP 409), never 40001: PostgREST < 16 retries 40001 forever.
    RAISE EXCEPTION 'Solidgate PWA reconcile fence changed during resume'
      USING ERRCODE = 'PT409';
  END IF;

  RETURN TRUE;
END;
$$;
