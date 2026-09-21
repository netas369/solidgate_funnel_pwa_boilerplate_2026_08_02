\set ON_ERROR_STOP on

-- Run against a throwaway database with the complete migration chain applied.
-- Supabase owns auth.users as supabase_admin; reconnect only inside this
-- throwaway gate so fixture users can be inserted without granting postgres or
-- application roles write access to the auth directory.
\connect - supabase_admin

BEGIN;

INSERT INTO auth.users (id, email)
VALUES
  ('e1000000-0000-4000-8000-000000000001', 'identity-user@example.test'),
  ('e1000000-0000-4000-8000-000000000002', 'legacy-pwa@example.test');

INSERT INTO public.sessions (id, user_id, email, locale, last_oto_step)
VALUES (
    'e1000000-0000-4000-8000-000000000101',
    'e1000000-0000-4000-8000-000000000001',
    'identity-user@example.test',
    'en',
    '1'
  ),
  (
    'e1000000-0000-4000-8000-000000000102',
    'e1000000-0000-4000-8000-000000000001',
    'legacy-main@example.test',
    'lt',
    '1'
  );

DO $$
DECLARE
  v_user UUID := 'e1000000-0000-4000-8000-000000000001';
  v_main_session UUID := 'e1000000-0000-4000-8000-000000000101';
  v_legacy_session UUID := 'e1000000-0000-4000-8000-000000000102';
  v_legacy_pwa_user UUID := 'e1000000-0000-4000-8000-000000000002';
  v_main_metadata JSONB := '{
    "funnel_code":"BRAND",
    "funnel_variant":"main",
    "session_id":"e1000000-0000-4000-8000-000000000101",
    "product_slug":"trial1",
    "price_id":"price-main-identity"
  }'::JSONB;
  v_pwa_metadata JSONB := '{
    "funnel_code":"PWA",
    "funnel_variant":"member_area",
    "session_id":"u-e1000000-0000-4000-8000-000000000001",
    "product_slug":"oto3_bundle_all",
    "locale":"lt"
  }'::JSONB;
  v_legacy_main_metadata JSONB := '{
    "funnel_code":"BRAND",
    "funnel_variant":"main",
    "session_id":"e1000000-0000-4000-8000-000000000102",
    "product_slug":"trial1",
    "price_id":"price-legacy-main"
  }'::JSONB;
  v_legacy_pwa_metadata JSONB := '{
    "funnel_code":"PWA",
    "funnel_variant":"member_area",
    "session_id":"u-e1000000-0000-4000-8000-000000000002",
    "product_slug":"oto3_bundle_all",
    "locale":"lt"
  }'::JSONB;
  v_main RECORD;
  v_main_retry RECORD;
  v_main_identity RECORD;
  v_pwa RECORD;
  v_pwa_identity RECORD;
  v_saved RECORD;
  v_saved_actionable RECORD;
  v_saved_newer RECORD;
  v_result TEXT;
  v_boolean BOOLEAN;
BEGIN
  -- Rolling old application code must lose execution before it can rebuild a
  -- provider payload from mutable profile state. Only the identity-aware RPCs
  -- remain callable by service_role.
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.open_solidgate_main_checkout(text,uuid,text,text,integer,text,text,jsonb,uuid,uuid)',
    'EXECUTE'
  ), 'service_role can still call the legacy main opener';
  ASSERT has_function_privilege(
    'service_role',
    'public.open_solidgate_main_checkout_v2(text,uuid,text,text,integer,text,text,jsonb,uuid,text,text,text,text,uuid)',
    'EXECUTE'
  ), 'service_role cannot call the identity-aware main opener';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.open_solidgate_pwa_purchase(text,uuid,text,text,integer,text,jsonb,text,uuid)',
    'EXECUTE'
  ), 'service_role can still call the legacy PWA opener';
  ASSERT has_function_privilege(
    'service_role',
    'public.open_solidgate_pwa_purchase_v2(text,uuid,text,text,integer,text,jsonb,text,uuid,text,text,text,text)',
    'EXECUTE'
  ), 'service_role cannot call the identity-aware PWA opener';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.reconcile_solidgate_legacy_order_identity(text,text,text,text,text,text,integer,text,jsonb,text,text,text)',
    'EXECUTE'
  ), 'service_role can forge a legacy checkout identity';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.clear_solidgate_legacy_session_vault(text,uuid)',
    'EXECUTE'
  ), 'service_role can clear an operator-owned legacy vault';

  SELECT opened.* INTO STRICT v_main
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_main_session,
    'trial1',
    'BRAND_000000_SUB',
    500,
    'usd',
    'BRAND_000000_SUB',
    v_main_metadata,
    'e1000000-0000-4000-8000-000000000011',
    ' Identity-User@Example.Test ',
    'en',
    'price-main-identity',
    'auth_settle',
    v_user
  ) AS opened;
  ASSERT v_main.is_new AND v_main.should_build;
  ASSERT v_main.solidgate_order_id = v_main_session::TEXT || ':trial1:1';
  ASSERT v_main.bound_customer_email = 'identity-user@example.test';
  ASSERT v_main.bound_checkout_locale = 'en';
  ASSERT v_main.bound_solidgate_product_id = 'price-main-identity';
  ASSERT v_main.bound_solidgate_payment_action = 'auth_settle';

  -- Mutable profile and live-catalog changes cannot alter an already-opened
  -- provider identity. The getter returns the exact historical snapshot that
  -- the caller must use for a retry.
  UPDATE public.sessions
  SET email = 'changed-profile@example.test', locale = 'lt'
  WHERE id = v_main_session;
  UPDATE auth.users
  SET email = 'changed-auth@example.test'
  WHERE id = v_user;

  SELECT identity.* INTO STRICT v_main_identity
  FROM public.get_solidgate_main_checkout_identity(
    'sandbox', v_main_session, 'BRAND_000000_SUB'
  ) AS identity;
  ASSERT v_main_identity.order_db_id = v_main.order_db_id;
  ASSERT v_main_identity.customer_email = 'identity-user@example.test';
  ASSERT v_main_identity.checkout_locale = 'en';
  ASSERT v_main_identity.solidgate_product_id = 'price-main-identity';
  ASSERT v_main_identity.amount_cents = 500;
  ASSERT v_main_identity.currency = 'usd';
  ASSERT v_main_identity.tracking_metadata = v_main_metadata;

  SELECT opened.* INTO STRICT v_main_retry
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_main_session,
    v_main_identity.offer_slug,
    'BRAND_000000_SUB',
    v_main_identity.amount_cents,
    v_main_identity.currency,
    'BRAND_000000_SUB',
    v_main_identity.tracking_metadata,
    'e1000000-0000-4000-8000-000000000012',
    v_main_identity.customer_email,
    v_main_identity.checkout_locale,
    v_main_identity.solidgate_product_id,
    v_main_identity.solidgate_payment_action,
    v_main_identity.user_id
  ) AS opened;
  ASSERT v_main_retry.order_db_id = v_main.order_db_id;
  ASSERT v_main_retry.solidgate_order_id = v_main.solidgate_order_id;
  ASSERT NOT v_main_retry.is_new;

  BEGIN
    UPDATE public.orders
    SET solidgate_customer_email = 'attacker@example.test'
    WHERE id = v_main.order_db_id;
    RAISE EXCEPTION 'immutable checkout email was directly rewritten';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A provider-terminal attempt retains its original gross and the next open
  -- advances to exactly N+1.
  UPDATE public.orders
  SET status = 'failed',
      amount_cents = 0,
      solidgate_payment_status = 'declined'
  WHERE id = v_main.order_db_id;
  SELECT opened.* INTO STRICT v_main_retry
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox', v_main_session, 'trial1', 'BRAND_000000_SUB', 500, 'usd',
    'BRAND_000000_SUB', v_main_metadata,
    'e1000000-0000-4000-8000-000000000013',
    'identity-user@example.test', 'en', 'price-main-identity',
    'auth_settle', v_user
  ) AS opened;
  ASSERT v_main_retry.solidgate_order_id = v_main_session::TEXT || ':trial1:2';
  ASSERT v_main_retry.is_new AND v_main_retry.should_build;
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = v_main.order_db_id
      AND amount_cents = 0
      AND solidgate_original_amount_cents = 500
  ), 'terminal retry rewrote the historical main gross';

  -- A delayed callback for the older main order cannot replace the card from
  -- the later order, even when both callbacks are otherwise captured.
  UPDATE public.orders
  SET status = 'active',
      amount_cents = solidgate_original_amount_cents,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'settle_ok'
  WHERE id IN (v_main.order_db_id, v_main_retry.order_db_id);
  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_main_session, v_main.order_db_id, v_main_session::TEXT,
    'token-old', 'visa', '1111'
  );
  ASSERT v_result = 'written';
  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_main_session, v_main_retry.order_db_id, v_main_session::TEXT,
    'token-new', 'mastercard', '2222'
  );
  ASSERT v_result = 'written';
  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_main_session, v_main.order_db_id, v_main_session::TEXT,
    'token-old', 'visa', '1111'
  );
  ASSERT v_result = 'stale';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_main_session
      AND card_token = 'token-new'
      AND card_source_order_id = v_main_retry.order_db_id
      AND NOT card_source_legacy
  ), 'late older main callback replaced the session vault winner';

  SELECT opened.* INTO STRICT v_pwa
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    v_user,
    'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    3000,
    'eur',
    v_pwa_metadata,
    'hosted_form',
    'e1000000-0000-4000-8000-000000000021',
    'pwa-checkout@example.test',
    'lt',
    NULL,
    'auth_settle'
  ) AS opened;
  ASSERT v_pwa.solidgate_order_id =
    'u-' || v_user::TEXT || ':oto3_bundle_all:1';
  ASSERT v_pwa.bound_user_id = v_user;
  ASSERT v_pwa.bound_tracking_metadata ->> 'session_id' = 'u-' || v_user::TEXT;
  ASSERT v_pwa.bound_customer_email = 'pwa-checkout@example.test';
  ASSERT v_pwa.bound_checkout_locale = 'lt';
  ASSERT v_pwa.bound_solidgate_product_id IS NULL;

  SELECT identity.* INTO STRICT v_pwa_identity
  FROM public.get_solidgate_pwa_checkout_identity(
    'sandbox', v_user, 'BRANDBUNDLE_000000_PDF'
  ) AS identity;
  ASSERT v_pwa_identity.order_db_id = v_pwa.order_db_id;
  ASSERT v_pwa_identity.customer_email = 'pwa-checkout@example.test';
  ASSERT v_pwa_identity.checkout_locale = 'lt';
  ASSERT v_pwa_identity.amount_cents = 3000;
  ASSERT v_pwa_identity.currency = 'eur';
  ASSERT v_pwa_identity.tracking_metadata = v_pwa_metadata;

  PERFORM public.finalize_solidgate_pwa_form_v2(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_pwa.order_db_id, v_pwa.solidgate_order_id, 3000, 'eur',
    'e1000000-0000-4000-8000-000000000021',
    '{"merchant":"identity-hosted","paymentIntent":"identity-intent","signature":"durable"}'::JSONB,
    'pwa-checkout@example.test', 'lt'
  );
  UPDATE public.orders
  SET status = 'completed',
      solidgate_payment_status = 'settle_ok',
      solidgate_subscription_id = NULL
  WHERE id = v_pwa.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_pwa.order_db_id, v_pwa.solidgate_order_id,
    3000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'hosted_form';
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF',
    v_pwa.order_db_id, v_pwa.solidgate_order_id,
    3000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'hosted_form',
    'identical hosted capture replay was not idempotent';
  BEGIN
    PERFORM public.record_solidgate_pwa_confirmed_capture(
      'sandbox', v_user, 'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_pwa.order_db_id, v_pwa.solidgate_order_id,
      2999, 'eur', 'settle_ok', NULL
    );
    RAISE EXCEPTION 'mismatched confirmed amount republished a PWA capture';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.orders
    SET solidgate_refunded_amount_cents = 1
    WHERE id = v_pwa.order_db_id;
    PERFORM public.record_solidgate_pwa_confirmed_capture(
      'sandbox', v_user, 'oto3_bundle_all',
      'BRANDBUNDLE_000000_PDF',
      v_pwa.order_db_id, v_pwa.solidgate_order_id,
      3000, 'eur', 'settle_ok', NULL
    );
    RAISE EXCEPTION 'reversed PWA order republished a captured state';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND product_slug = 'BRANDBUNDLE_000000_PDF'
      AND order_db_id = v_pwa.order_db_id
      AND purchase_mode = 'hosted_form'
      AND last_result_kind = 'captured'
      AND last_result_net_amount_cents = 3000
  ), 'hosted confirmation did not publish durable captured state';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_pwa.order_db_id, NULL,
    'token-pwa-hosted', 'visa', '4242'
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND card_token = 'token-pwa-hosted'
      AND card_source_kind = 'pwa_order'
      AND card_source_id = v_pwa.order_db_id::TEXT
  ), 'captured hosted PWA order could not write the account vault';

  -- A signed webhook can be the first durable publisher after a saved-card
  -- charge. Recover both the pre-publication crash window and an ACS return,
  -- while never treating the provider AUTH as a new account-vault source.
  SELECT opened.* INTO STRICT v_saved
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF', 2000, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto3_bundle_1', 'locale', 'lt'
    ),
    'saved_card', 'e1000000-0000-4000-8000-000000000031',
    'pwa-checkout@example.test', 'lt', NULL, 'auth_settle'
  ) AS opened;
  ASSERT v_saved.should_submit AND v_saved.claim_token IS NOT NULL;
  UPDATE public.orders
  SET status = 'completed',
      solidgate_payment_status = 'settle_ok',
      solidgate_verify_url = NULL,
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE id = v_saved.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF',
    v_saved.order_db_id, v_saved.solidgate_order_id,
    2000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'saved_card',
    'webhook could not publish an unrecorded saved-card capture';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND product_slug = 'BRANDBUNDLE1_000000_PDF'
      AND order_db_id = v_saved.order_db_id
      AND purchase_mode = 'saved_card'
      AND claim_kind IS NULL
      AND claim_started_at IS NULL
      AND last_result_kind = 'captured'
      AND last_result_net_amount_cents = 2000
      AND last_result_verify_url IS NULL
  ), 'saved-card crash recovery did not atomically publish captured state';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_saved.order_db_id, NULL,
    'token-must-not-win', 'mastercard', '9999'
  );
  ASSERT v_result = 'invalid',
    'saved-card order was accepted as a fresh hosted-form token source';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND card_token = 'token-pwa-hosted'
      AND card_source_id = v_pwa.order_db_id::TEXT
  ), 'saved-card webhook AUTH replaced the existing account vault';

  SELECT opened.* INTO STRICT v_saved_actionable
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto3_bundle_2',
    'BRANDBUNDLE2_000000_PDF', 2000, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto3_bundle_2', 'locale', 'lt'
    ),
    'saved_card', 'e1000000-0000-4000-8000-000000000032',
    'pwa-checkout@example.test', 'lt', NULL, 'auth_settle'
  ) AS opened;
  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox', v_user, 'oto3_bundle_2',
    'BRANDBUNDLE2_000000_PDF',
    v_saved_actionable.order_db_id, v_saved_actionable.solidgate_order_id,
    2000, 'eur', v_saved_actionable.claim_token,
    'requires_action', '3ds_verify', 2000, NULL,
    'https://pay.example.test/3ds-return'
  ), 'saved-card requires_action fixture was not claim-fenced';
  UPDATE public.orders
  SET status = 'completed',
      solidgate_payment_status = 'settle_ok',
      solidgate_verify_url = NULL,
      solidgate_submission_token = NULL,
      solidgate_submission_started_at = NULL
  WHERE id = v_saved_actionable.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_2',
    'BRANDBUNDLE2_000000_PDF',
    v_saved_actionable.order_db_id, v_saved_actionable.solidgate_order_id,
    2000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'saved_card',
    'exact ACS return could not advance requires_action to captured';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND product_slug = 'BRANDBUNDLE2_000000_PDF'
      AND last_result_kind = 'captured'
      AND last_result_net_amount_cents = 2000
      AND last_result_verify_url IS NULL
      AND claim_kind IS NULL
      AND claim_started_at IS NULL
  ), 'saved-card ACS state retained stale verify/lease data';

  -- If this exact paid order later loses the current state pointer to a newer
  -- (now retired) attempt, it is still entitled to grant arbitration. The
  -- older signed event must not mutate the newer state or supply a vault token.
  UPDATE public.orders SET status = 'canceled' WHERE id = v_saved.order_db_id;
  SELECT opened.* INTO STRICT v_saved_newer
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF', 2000, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto3_bundle_1', 'locale', 'lt'
    ),
    'saved_card', 'e1000000-0000-4000-8000-000000000033',
    'pwa-checkout@example.test', 'lt', NULL, 'auth_settle'
  ) AS opened;
  UPDATE public.orders
  SET created_at = (
        SELECT older.created_at + INTERVAL '1 second'
        FROM public.orders AS older WHERE older.id = v_saved.order_db_id
      ),
      status = 'canceled'
  WHERE id = v_saved_newer.order_db_id;
  UPDATE public.orders SET status = 'completed' WHERE id = v_saved.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF',
    v_saved.order_db_id, v_saved.solidgate_order_id,
    2000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'stale',
    'older exact captured order was not classified behind the newer state';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND product_slug = 'BRANDBUNDLE1_000000_PDF'
      AND order_db_id = v_saved_newer.order_db_id
      AND last_result_kind IS NULL
  ), 'stale signed capture mutated the newer PWA purchase state';
  BEGIN
    UPDATE public.orders
    SET created_at = (
      SELECT older.created_at - INTERVAL '1 second'
      FROM public.orders AS older WHERE older.id = v_saved.order_db_id
    )
    WHERE id = v_saved_newer.order_db_id;
    PERFORM public.record_solidgate_pwa_confirmed_capture(
      'sandbox', v_user, 'oto3_bundle_1',
      'BRANDBUNDLE1_000000_PDF',
      v_saved.order_db_id, v_saved.solidgate_order_id,
      2000, 'eur', 'settle_ok', NULL
    );
    RAISE EXCEPTION 'non-newer current state was misclassified as stale';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Simulate two pre-cutover rows. The identity trigger is disabled only for
  -- fixture creation; every tested application/operator action runs with all
  -- guards enabled.
  ALTER TABLE public.orders DISABLE TRIGGER guard_solidgate_checkout_identity_trigger;
  INSERT INTO public.orders (
    id, psp, payment_environment, solidgate_order_id, session_id, user_id,
    status, amount_cents, currency, product_name, product_slug,
    solidgate_original_amount_cents, tracking_metadata,
    solidgate_checkout_identity_legacy
  ) VALUES (
    'e1000000-0000-4000-8000-000000000201',
    'solidgate', 'sandbox', v_legacy_session::TEXT || ':trial1:1',
    v_legacy_session, v_user, 'pending', 500, 'usd',
    'BRAND_000000_SUB', 'BRAND_000000_SUB', 500,
    v_legacy_main_metadata, TRUE
  );
  INSERT INTO public.orders (
    id, psp, payment_environment, solidgate_order_id, session_id, user_id,
    status, amount_cents, currency, product_name, product_slug,
    solidgate_original_amount_cents, tracking_metadata,
    solidgate_checkout_identity_legacy
  ) VALUES (
    'e1000000-0000-4000-8000-000000000202',
    'solidgate', 'sandbox',
    'u-' || v_legacy_pwa_user::TEXT || ':oto3_bundle_all:1',
    NULL, v_legacy_pwa_user, 'pending', 3000, 'eur',
    'BRANDBUNDLE_000000_PDF', 'BRANDBUNDLE_000000_PDF', 3000,
    v_legacy_pwa_metadata, TRUE
  );
  ALTER TABLE public.orders ENABLE TRIGGER guard_solidgate_checkout_identity_trigger;

  INSERT INTO public.solidgate_main_checkout_states (
    payment_environment, session_id, product_slug, offer_slug,
    order_db_id, builder_token
  ) VALUES (
    'sandbox', v_legacy_session, 'BRAND_000000_SUB', 'trial1',
    'e1000000-0000-4000-8000-000000000201',
    'e1000000-0000-4000-8000-000000000031'
  );
  BEGIN
    PERFORM 1 FROM public.get_solidgate_main_checkout_identity(
      'sandbox', v_legacy_session, 'BRAND_000000_SUB'
    );
    RAISE EXCEPTION 'legacy main getter returned a reconstructed identity';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  ALTER TABLE public.solidgate_session_vault
    DISABLE TRIGGER guard_solidgate_session_vault_card_source_insert_trigger;
  INSERT INTO public.solidgate_session_vault (
    payment_environment, session_id, customer_account_id,
    card_token, card_brand, card_last4, card_source_legacy
  ) VALUES (
    'sandbox', v_legacy_session, v_legacy_session::TEXT,
    'legacy-card-token', 'visa', '3333', TRUE
  );
  ALTER TABLE public.solidgate_session_vault
    ENABLE TRIGGER guard_solidgate_session_vault_card_source_insert_trigger;

  BEGIN
    PERFORM public.reconcile_solidgate_legacy_order_identity(
      'sandbox', v_legacy_session::TEXT || ':trial1:1',
      'legacy-main@example.test', v_legacy_session::TEXT,
      'LT_BRAND_000000_SUB', 'wrong-provider-product',
      500, 'usd', v_legacy_main_metadata,
      'legacy-card-token', 'visa', '3333'
    );
    RAISE EXCEPTION 'mismatched provider product reconciled a legacy order';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'e1000000-0000-4000-8000-000000000201'
      AND solidgate_checkout_identity_legacy
  );
  v_boolean := public.reconcile_solidgate_legacy_order_identity(
    'sandbox', v_legacy_session::TEXT || ':trial1:1',
    ' Legacy-Main@Example.Test ', v_legacy_session::TEXT,
    'LT_BRAND_000000_SUB', 'price-legacy-main',
    500, 'usd', v_legacy_main_metadata,
    'legacy-card-token', 'visa', '3333'
  );
  ASSERT v_boolean;
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'e1000000-0000-4000-8000-000000000201'
      AND NOT solidgate_checkout_identity_legacy
      AND solidgate_customer_email = 'legacy-main@example.test'
      AND solidgate_checkout_locale = 'lt'
      AND solidgate_product_id = 'price-legacy-main'
      AND solidgate_payment_action = 'auth_settle'
  ), 'exact provider evidence did not bind the legacy order';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_legacy_session
      AND card_token = 'legacy-card-token'
      AND card_source_order_id = 'e1000000-0000-4000-8000-000000000201'
      AND NOT card_source_legacy
  ), 'exact provider card evidence did not source-bind the legacy token';

  -- PWA provider customer_account_id is the raw authenticated UUID. The `u-`
  -- prefix belongs only to order_id and merchant metadata.
  BEGIN
    PERFORM public.reconcile_solidgate_legacy_order_identity(
      'sandbox',
      'u-' || v_legacy_pwa_user::TEXT || ':oto3_bundle_all:1',
      'legacy-pwa@example.test', 'u-' || v_legacy_pwa_user::TEXT,
      'LT_BRANDBUNDLE_000000_PDF', NULL,
      3000, 'eur', v_legacy_pwa_metadata, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'u-prefixed PWA provider account id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  ASSERT public.reconcile_solidgate_legacy_order_identity(
    'sandbox',
    'u-' || v_legacy_pwa_user::TEXT || ':oto3_bundle_all:1',
    'legacy-pwa@example.test', v_legacy_pwa_user::TEXT,
    'LT_BRANDBUNDLE_000000_PDF', NULL,
    3000, 'eur', v_legacy_pwa_metadata, NULL, NULL, NULL
  );
  ASSERT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = 'e1000000-0000-4000-8000-000000000202'
      AND NOT solidgate_checkout_identity_legacy
      AND solidgate_customer_email = 'legacy-pwa@example.test'
      AND solidgate_checkout_locale = 'lt'
      AND solidgate_product_id IS NULL
      AND solidgate_payment_action = 'auth_settle'
  ), 'raw PWA provider account id did not reconcile exact evidence';

  RAISE NOTICE 'SOLIDGATE PAYMENT IDENTITY SCENARIOS PASSED';
END $$;

-- Equal-time subscription owners are ordered by the immutable order tuple.
-- A callback for the lexically older order is stale once the entitlement has
-- moved to the newer equal-time order. These are account/PWA orders: creating
-- two payable session OTO2 orders would violate the newer one-open-step guard
-- and is not a valid way to construct this lifecycle-only history fixture.
INSERT INTO public.orders (
  id, psp, payment_environment, solidgate_order_id, session_id, user_id,
  status, amount_cents, currency, product_name, product_slug,
  solidgate_subscription_id, solidgate_original_amount_cents,
  solidgate_payment_status, tracking_metadata,
  solidgate_customer_email, solidgate_checkout_locale,
  solidgate_product_id, solidgate_payment_action,
  solidgate_checkout_identity_bound_at, solidgate_checkout_identity_legacy,
  created_at
)
VALUES
  (
    'e1000000-0000-4000-8000-000000000301',
    'solidgate', 'sandbox',
    'u-e1000000-0000-4000-8000-000000000001:oto2_addon_weekly:1',
    NULL,
    'e1000000-0000-4000-8000-000000000001',
    'active', 100, 'eur',
    'BRANDADDON_000000_SUB', 'BRANDADDON_000000_SUB',
    'sub-equal-old', 100, 'settle_ok',
    '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-e1000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-equal"}'::JSONB,
    'identity-user@example.test', 'en', 'price-equal', 'auth_settle',
    '2026-07-21T12:00:00Z', FALSE, '2026-07-21T12:00:00Z'
  );

-- A real N+1 PWA attempt can exist only after the first provider attempt is
-- terminal and non-payable. Keep the immutable gross while zeroing the net;
-- this produces truthful history without weakening the production guard.
UPDATE public.orders
SET status = 'failed',
    amount_cents = 0,
    solidgate_payment_status = 'declined'
WHERE id = 'e1000000-0000-4000-8000-000000000301';

INSERT INTO public.orders (
  id, psp, payment_environment, solidgate_order_id, session_id, user_id,
  status, amount_cents, currency, product_name, product_slug,
  solidgate_subscription_id, solidgate_original_amount_cents,
  solidgate_payment_status, tracking_metadata,
  solidgate_customer_email, solidgate_checkout_locale,
  solidgate_product_id, solidgate_payment_action,
  solidgate_checkout_identity_bound_at, solidgate_checkout_identity_legacy,
  created_at
)
VALUES (
    'e1000000-0000-4000-8000-000000000302',
    'solidgate', 'sandbox',
    'u-e1000000-0000-4000-8000-000000000001:oto2_addon_weekly:2',
    NULL,
    'e1000000-0000-4000-8000-000000000001',
    'active', 100, 'eur',
    'BRANDADDON_000000_SUB', 'BRANDADDON_000000_SUB',
    'sub-equal-new', 100, 'settle_ok',
    '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-e1000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-equal"}'::JSONB,
    'identity-user@example.test', 'en', 'price-equal', 'auth_settle',
    '2026-07-21T12:00:00Z', FALSE, '2026-07-21T12:00:00Z'
  );

INSERT INTO public.entitlements (
  payment_environment, user_id, product_slug, access_level, status,
  order_id, expires_at, source, solidgate_subscription_id
)
VALUES (
  'sandbox',
  'e1000000-0000-4000-8000-000000000001',
  'BRANDADDON_000000_SUB',
  'full', 'active',
  'e1000000-0000-4000-8000-000000000302',
  NOW() + INTERVAL '7 days',
  'solidgate_oto', 'sub-equal-new'
);

DO $$
DECLARE
  v_result TEXT;
BEGIN
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox',
    'e1000000-0000-4000-8000-000000000301',
    'e1000000-0000-4000-8000-000000000001',
    'BRANDADDON_000000_SUB',
    'sub-equal-old',
    'grace', 'past_due', NULL, 'solidgate_webhook'
  );
  ASSERT v_result = 'stale',
    format('equal-time older lifecycle owner returned %s', v_result);
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox'
      AND user_id = 'e1000000-0000-4000-8000-000000000001'
      AND product_slug = 'BRANDADDON_000000_SUB'
      AND order_id = 'e1000000-0000-4000-8000-000000000302'
      AND solidgate_subscription_id = 'sub-equal-new'
      AND status = 'active'
  ), 'equal-time older lifecycle callback changed the newer owner';
  RAISE NOTICE 'SOLIDGATE EQUAL-TIME LIFECYCLE SCENARIO PASSED';
END $$;

ROLLBACK;

\echo SOLIDGATE PAYMENT IDENTITY TESTS PASSED
