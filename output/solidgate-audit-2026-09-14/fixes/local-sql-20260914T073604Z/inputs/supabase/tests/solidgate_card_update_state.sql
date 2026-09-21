\set ON_ERROR_STOP on

-- Run against a throwaway database with the complete migration chain applied.
BEGIN;

INSERT INTO auth.users (id, email)
VALUES
  (
    'd1000000-0000-4000-8000-000000000001',
    'card-update-sql@example.test'
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    'card-update-newer-sub@example.test'
  ),
  (
    'd1000000-0000-4000-8000-000000000003',
    'tokenless-watermark@example.test'
  ),
  (
    'd1000000-0000-4000-8000-000000000004',
    'main-watermark@example.test'
  );

INSERT INTO public.sessions (id, user_id, email, locale, last_oto_step)
VALUES (
  'd1000000-0000-4000-8000-000000000101',
  'd1000000-0000-4000-8000-000000000001',
  'card-update-sql@example.test',
  'lt',
  '2'
), (
  'd1000000-0000-4000-8000-000000000104',
  'd1000000-0000-4000-8000-000000000004',
  'main-watermark@example.test',
  'lt',
  NULL
);

DO $$
DECLARE
  v_user UUID := 'd1000000-0000-4000-8000-000000000001';
  v_order_one TEXT := 'u-d1000000-0000-4000-8000-000000000001:card_update:1';
  v_order_two TEXT := 'u-d1000000-0000-4000-8000-000000000001:card_update:2';
  v_builder_one UUID := 'd1000000-0000-4000-8000-000000000011';
  v_builder_two UUID := 'd1000000-0000-4000-8000-000000000012';
  v_apply_one UUID := 'd1000000-0000-4000-8000-000000000021';
  v_apply_two UUID := 'd1000000-0000-4000-8000-000000000022';
  v_opened RECORD;
  v_read RECORD;
  v_sync RECORD;
  v_sync_state RECORD;
  v_subscription_opened RECORD;
  v_subscription_order_id UUID;
  v_attempt_one UUID;
  v_attempt_two UUID;
  v_boolean BOOLEAN;
  v_capture_result TEXT;
  v_claim TEXT;
  v_vault_result TEXT;
BEGIN
  ASSERT NOT has_table_privilege(
    'service_role',
    'public.solidgate_card_update_attempts',
    'SELECT'
  ), 'service_role can bypass the card-update state machine';
  ASSERT has_function_privilege(
    'service_role',
    'public.open_solidgate_card_update_attempt(text,uuid,text,text,text,uuid)',
    'EXECUTE'
  ), 'service_role cannot call the card-update opener';
  ASSERT NOT has_function_privilege(
    'authenticated',
    'public.claim_solidgate_card_update_attempt(text,uuid,text,uuid)',
    'EXECUTE'
  ), 'authenticated can consume a card-update attempt directly';
  ASSERT NOT has_table_privilege(
    'service_role',
    'public.solidgate_subscription_token_sync_jobs',
    'SELECT'
  ), 'service_role can bypass the subscription-token sync state machine';
  ASSERT has_function_privilege(
    'service_role',
    'public.claim_solidgate_subscription_token_sync(text,integer,integer,uuid)',
    'EXECUTE'
  ), 'service_role cannot claim subscription-token sync jobs';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.enqueue_solidgate_subscription_token_sync(text,uuid)',
    'EXECUTE'
  ), 'service_role can enqueue an unproven vault source directly';
  ASSERT NOT has_function_privilege(
    'service_role',
    'public.solidgate_subscription_token_sync_is_billable(text,uuid,text)',
    'EXECUTE'
  ), 'service_role can bypass exact subscription provenance checks';

  -- Open/capture the subscription before the replacement card exists. Its
  -- delayed entitlement grant below must enqueue that strictly newer card.
  SELECT opened.* INTO STRICT v_subscription_opened
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    100,
    'eur',
    '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-d1000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-card-update-sync"}'::JSONB,
    'hosted_form',
    'd1000000-0000-4000-8000-000000000031',
    'card-update-sql@example.test',
    'lt',
    'price-card-update-sync',
    'auth_settle'
  ) AS opened;
  v_subscription_order_id := v_subscription_opened.order_db_id;
  PERFORM public.finalize_solidgate_pwa_form_v2(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_subscription_order_id,
    v_subscription_opened.solidgate_order_id,
    100,
    'eur',
    v_subscription_opened.claim_token,
    '{"merchant":"subscription-sync","paymentIntent":"intent-sync","signature":"signature-sync"}'::JSONB,
    v_subscription_opened.bound_customer_email,
    v_subscription_opened.bound_checkout_locale
  );
  UPDATE public.orders
  SET status = 'active',
      solidgate_payment_status = 'settle_ok',
      solidgate_subscription_id = 'sub-card-update-sql'
  WHERE id = v_subscription_order_id;
  v_capture_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_subscription_order_id,
    v_subscription_opened.solidgate_order_id,
    100,
    'eur',
    'settle_ok',
    'sub-card-update-sql'
  );
  ASSERT v_capture_result = 'hosted_form',
    'PWA subscription capture state was not published';

  SELECT opened.* INTO STRICT v_opened
  FROM public.open_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_order_one,
    'CARD-UPDATE-SQL@EXAMPLE.TEST',
    'lt',
    v_builder_one
  ) AS opened;
  ASSERT v_opened.solidgate_order_id = v_order_one;
  ASSERT v_opened.bound_customer_email = 'card-update-sql@example.test';
  ASSERT v_opened.is_new AND v_opened.should_build;
  v_attempt_one := v_opened.attempt_id;

  SELECT public.finalize_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_opened.attempt_id,
    v_order_one,
    v_builder_one,
    '{"merchant":"durable"}'::JSONB
  ) INTO STRICT v_boolean;
  ASSERT v_boolean, 'builder could not finalize its exact attempt';

  SELECT opened.* INTO STRICT v_opened
  FROM public.open_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_order_two,
    'changed-profile@example.test',
    'en',
    v_builder_two
  ) AS opened;
  ASSERT v_opened.solidgate_order_id = v_order_one,
    'an issued current attempt was replaced before terminal consumption';
  ASSERT v_opened.bound_customer_email = 'card-update-sql@example.test',
    'a mutable profile email changed an issued provider identity';
  ASSERT v_opened.bound_checkout_locale = 'lt',
    'a mutable profile locale changed an issued provider identity';
  ASSERT NOT v_opened.is_new AND NOT v_opened.should_build;
  ASSERT v_opened.merchant_data = '{"merchant":"durable"}'::JSONB;

  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_one
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'acquired';

  SELECT public.write_solidgate_account_vault_monotonic(
    'sandbox',
    v_user,
    'card_update',
    v_opened.attempt_id,
    v_apply_one,
    'token-one',
    'visa',
    '1111'
  ) INTO STRICT v_vault_result;
  ASSERT v_vault_result = 'written', 'first exact card source did not write the vault';

  ASSERT public.grant_solidgate_pwa_entitlement(
    'sandbox',
    v_subscription_order_id,
    v_user,
    'BRANDADDON_000000_SUB',
    'full',
    NOW() + INTERVAL '30 days',
    'sub-card-update-sql',
    'solidgate_pwa'
  ), 'exact captured subscription entitlement was not granted';
  ASSERT public.solidgate_subscription_token_sync_is_billable(
    'sandbox', v_user, 'sub-card-update-sql'
  ), 'exact entitlement-to-order subscription provenance was not billable';
  ASSERT EXISTS (
    SELECT 1
    FROM public.solidgate_subscription_token_sync_jobs AS sync_job
    WHERE sync_job.payment_environment = 'sandbox'
      AND sync_job.user_id = v_user
      AND sync_job.solidgate_subscription_id = 'sub-card-update-sql'
      AND sync_job.status = 'pending'
      AND sync_job.desired_source_kind = 'card_update'
      AND sync_job.desired_source_id = v_attempt_one::TEXT
  ), 'entitlement grant did not enqueue the current account-vault source';
  UPDATE public.orders
  SET solidgate_refunded_amount_cents = 25,
      solidgate_payment_status = 'refunded'
  WHERE id = v_subscription_order_id;
  ASSERT public.solidgate_subscription_token_sync_is_billable(
    'sandbox', v_user, 'sub-card-update-sql'
  ), 'partial refund incorrectly disabled an otherwise active subscription';
  UPDATE public.orders
  SET status = 'refunded'
  WHERE id = v_subscription_order_id;
  ASSERT NOT public.solidgate_subscription_token_sync_is_billable(
    'sandbox', v_user, 'sub-card-update-sql'
  ), 'fully refunded subscription remained billable';
  UPDATE public.orders
  SET status = 'active',
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'settle_ok'
  WHERE id = v_subscription_order_id;

  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_two
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'busy', 'a concurrent caller stole the live consume lease';

  SELECT public.release_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_one, 'auth_ok'
  ) INTO v_boolean;
  ASSERT v_boolean, 'consume owner could not release for an exact retry';

  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_two
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'acquired';
  SELECT public.write_solidgate_account_vault_monotonic(
    'sandbox',
    v_user,
    'card_update',
    v_opened.attempt_id,
    v_apply_two,
    'token-one',
    'visa',
    '1111'
  ) INTO STRICT v_vault_result;
  ASSERT v_vault_result = 'same', 'same exact source was not idempotent';
  SELECT public.complete_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_two, 'auth_ok'
  ) INTO v_boolean;
  ASSERT v_boolean, 'consume owner could not complete the exact attempt';

  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_one
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'completed', 'current completed replay was not idempotent';

  SELECT sync_job.* INTO STRICT v_sync
  FROM public.claim_solidgate_subscription_token_sync(
    'sandbox', 10, 300, v_user
  ) AS sync_job;
  ASSERT v_sync.solidgate_subscription_id = 'sub-card-update-sql';
  SELECT sync_state.* INTO STRICT v_sync_state
  FROM public.read_claimed_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token
  ) AS sync_state;
  ASSERT v_sync_state.card_token = 'token-one';
  ASSERT v_sync_state.desired_source_id = v_attempt_one::TEXT;
  ASSERT v_sync_state.subscription_is_billable,
    'exact active subscription was not reported billable';

  -- A later form makes the former completed URL permanently stale.
  SELECT opened.* INTO STRICT v_opened
  FROM public.open_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_order_two,
    'new-card@example.test',
    'en',
    v_builder_two
  ) AS opened;
  ASSERT v_opened.solidgate_order_id = v_order_two;
  ASSERT v_opened.is_new AND v_opened.should_build;
  v_attempt_two := v_opened.attempt_id;

  SELECT public.finalize_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_attempt_two,
    v_order_two,
    v_builder_two,
    '{"merchant":"newer"}'::JSONB
  ) INTO STRICT v_boolean;
  ASSERT v_boolean, 'newer builder could not finalize its exact attempt';
  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_two, v_apply_one
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'acquired';
  SELECT public.write_solidgate_account_vault_monotonic(
    'sandbox',
    v_user,
    'card_update',
    v_attempt_two,
    v_apply_one,
    'token-two',
    'mastercard',
    '2222'
  ) INTO STRICT v_vault_result;
  ASSERT v_vault_result = 'written', 'newer exact card source lost chronology';

  -- The newer source updates the desired generation but must preserve the
  -- existing worker lease. That old worker now sees token-two and cannot mark
  -- token-one applied after a slow provider response.
  SELECT sync_state.* INTO STRICT v_sync_state
  FROM public.read_claimed_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token
  ) AS sync_state;
  ASSERT v_sync_state.card_token = 'token-two';
  ASSERT v_sync_state.desired_source_id = v_attempt_two::TEXT;
  SELECT public.complete_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token,
    'card_update',
    v_attempt_one::TEXT
  ) INTO v_boolean;
  ASSERT v_boolean IS NOT TRUE,
    'old provider response completed a newer desired generation';
  SELECT public.complete_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token,
    'card_update',
    v_attempt_two::TEXT,
    TRUE
  ) INTO v_boolean;
  ASSERT v_boolean IS NOT TRUE,
    'non-billable completion succeeded while exact subscription was billable';

  UPDATE public.orders
  SET status = 'canceled'
  WHERE id = v_subscription_order_id;
  SELECT sync_state.* INTO STRICT v_sync_state
  FROM public.read_claimed_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token
  ) AS sync_state;
  ASSERT NOT v_sync_state.subscription_is_billable,
    'canceled exact subscription remained billable';
  UPDATE public.orders
  SET status = 'active'
  WHERE id = v_subscription_order_id;
  SELECT public.complete_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token,
    'card_update',
    v_attempt_two::TEXT,
    TRUE
  ) INTO v_boolean;
  ASSERT v_boolean IS NOT TRUE,
    'non-billable skip completed after billability returned';
  SELECT public.complete_solidgate_subscription_token_sync(
    'sandbox',
    v_user,
    'sub-card-update-sql',
    v_sync.claim_token,
    'card_update',
    v_attempt_two::TEXT,
    FALSE
  ) INTO v_boolean;
  ASSERT v_boolean, 'newest provider token generation did not complete';

  INSERT INTO public.entitlements (
    user_id,
    payment_environment,
    product_slug,
    access_level,
    status,
    solidgate_subscription_id,
    source
  ) VALUES (
    v_user,
    'sandbox',
    'malformed-subscription-source',
    'full',
    'active',
    'sub-without-order-proof',
    'legacy-test'
  );
  ASSERT NOT public.solidgate_subscription_token_sync_is_billable(
    'sandbox', v_user, 'sub-without-order-proof'
  ), 'entitlement without exact Solidgate order provenance became billable';
  SELECT public.complete_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_two, v_apply_one, 'auth_ok'
  ) INTO v_boolean;
  ASSERT v_boolean, 'newer card-update attempt did not complete';

  SELECT read.* INTO STRICT v_read
  FROM public.get_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one
  ) AS read;
  ASSERT NOT v_read.is_current, 'old card-update URL remained current';

  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_order_one, v_apply_one
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'rejected', 'old card-update URL regained token-write authority';

  BEGIN
    UPDATE public.solidgate_account_vault
    SET card_token = 'bypass-token'
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user;
    RAISE EXCEPTION 'direct token update bypassed monotonic vault writer';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.solidgate_account_vault (
      user_id,
      payment_environment,
      customer_account_id,
      card_token
    ) VALUES (
      v_user,
      'production',
      v_user::TEXT,
      'insert-bypass-token'
    );
    RAISE EXCEPTION 'direct token insert bypassed monotonic vault writer';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'SOLIDGATE CARD-UPDATE STATE SCENARIOS PASSED';
END $$;

-- The inverse chronology must never point a newly created provider
-- subscription back to a card that predates that subscription order.
DO $$
DECLARE
  v_user UUID := 'd1000000-0000-4000-8000-000000000002';
  v_card_order TEXT := 'u-d1000000-0000-4000-8000-000000000002:card_update:1';
  v_card_builder UUID := 'd1000000-0000-4000-8000-000000000041';
  v_card_apply UUID := 'd1000000-0000-4000-8000-000000000042';
  v_pwa_builder UUID := 'd1000000-0000-4000-8000-000000000043';
  v_opened RECORD;
  v_subscription RECORD;
  v_claim TEXT;
  v_boolean BOOLEAN;
  v_result TEXT;
BEGIN
  SELECT opened.* INTO STRICT v_opened
  FROM public.open_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_card_order,
    'card-update-newer-sub@example.test',
    'lt',
    v_card_builder
  ) AS opened;
  ASSERT public.finalize_solidgate_card_update_attempt(
    'sandbox',
    v_user,
    v_opened.attempt_id,
    v_card_order,
    v_card_builder,
    '{"merchant":"older-card"}'::JSONB
  ), 'older card builder did not finalize';
  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_card_order, v_card_apply
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'acquired';
  SELECT public.write_solidgate_account_vault_monotonic(
    'sandbox',
    v_user,
    'card_update',
    v_opened.attempt_id,
    v_card_apply,
    'older-token',
    'visa',
    '3333'
  ) INTO STRICT v_result;
  ASSERT v_result = 'written';
  SELECT public.complete_solidgate_card_update_attempt(
    'sandbox', v_user, v_card_order, v_card_apply, 'auth_ok'
  ) INTO v_boolean;
  ASSERT v_boolean;

  SELECT opened.* INTO STRICT v_subscription
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    100,
    'eur',
    '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-d1000000-0000-4000-8000-000000000002","product_slug":"oto2_addon_weekly","price_id":"price-newer-sub"}'::JSONB,
    'hosted_form',
    v_pwa_builder,
    'card-update-newer-sub@example.test',
    'lt',
    'price-newer-sub',
    'auth_settle'
  ) AS opened;
  PERFORM public.finalize_solidgate_pwa_form_v2(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_subscription.order_db_id,
    v_subscription.solidgate_order_id,
    100,
    'eur',
    v_subscription.claim_token,
    '{"merchant":"newer-subscription","paymentIntent":"intent-newer-sub","signature":"signature-newer-sub"}'::JSONB,
    v_subscription.bound_customer_email,
    v_subscription.bound_checkout_locale
  );
  UPDATE public.orders
  SET status = 'active',
      solidgate_payment_status = 'settle_ok',
      solidgate_subscription_id = 'sub-newer-than-vault'
  WHERE id = v_subscription.order_db_id;
  SELECT public.record_solidgate_pwa_confirmed_capture(
    'sandbox',
    v_user,
    'oto2_addon_weekly',
    'BRANDADDON_000000_SUB',
    v_subscription.order_db_id,
    v_subscription.solidgate_order_id,
    100,
    'eur',
    'settle_ok',
    'sub-newer-than-vault'
  ) INTO STRICT v_result;
  ASSERT v_result = 'hosted_form';
  ASSERT public.grant_solidgate_pwa_entitlement(
    'sandbox',
    v_subscription.order_db_id,
    v_user,
    'BRANDADDON_000000_SUB',
    'full',
    NOW() + INTERVAL '30 days',
    'sub-newer-than-vault',
    'solidgate_pwa'
  );
  ASSERT NOT EXISTS (
    SELECT 1
    FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE job.payment_environment = 'sandbox'
      AND job.user_id = v_user
      AND job.solidgate_subscription_id = 'sub-newer-than-vault'
  ), 'older vault token was queued onto a newer provider subscription';
END $$;

-- A newer captured hosted source remains authoritative even when its first
-- signed payload has no recurring token. It must hide C1, fence an in-flight
-- subscription update, and become claimable only after the same source fills.
DO $$
DECLARE
  v_user UUID := 'd1000000-0000-4000-8000-000000000003';
  v_card_order TEXT := 'u-d1000000-0000-4000-8000-000000000003:card_update:1';
  v_card_builder UUID := 'd1000000-0000-4000-8000-000000000311';
  v_card_apply UUID := 'd1000000-0000-4000-8000-000000000312';
  v_subscription_builder UUID := 'd1000000-0000-4000-8000-000000000321';
  v_watermark_builder UUID := 'd1000000-0000-4000-8000-000000000322';
  v_saved_claim UUID := 'd1000000-0000-4000-8000-000000000323';
  v_card RECORD;
  v_subscription RECORD;
  v_watermark RECORD;
  v_saved RECORD;
  v_sync RECORD;
  v_sync_state RECORD;
  v_result TEXT;
  v_claim TEXT;
  v_boolean BOOLEAN;
  v_count INTEGER;
BEGIN
  SELECT opened.* INTO STRICT v_subscription
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto2_addon_weekly',
    'BRANDADDON_000000_SUB', 100, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto2_addon_weekly',
      'price_id', 'price-watermark-sub'
    ),
    'hosted_form', v_subscription_builder,
    'tokenless-watermark@example.test', 'lt',
    'price-watermark-sub', 'auth_settle'
  ) AS opened;
  PERFORM public.finalize_solidgate_pwa_form_v2(
    'sandbox', v_user, 'oto2_addon_weekly',
    'BRANDADDON_000000_SUB', v_subscription.order_db_id,
    v_subscription.solidgate_order_id, 100, 'eur',
    v_subscription.claim_token,
    '{"merchant":"watermark-sub","paymentIntent":"intent-watermark-sub","signature":"signed"}'::JSONB,
    v_subscription.bound_customer_email,
    v_subscription.bound_checkout_locale
  );
  UPDATE public.orders
  SET status = 'active',
      solidgate_payment_status = 'settle_ok',
      solidgate_subscription_id = 'sub-tokenless-watermark'
  WHERE id = v_subscription.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto2_addon_weekly',
    'BRANDADDON_000000_SUB', v_subscription.order_db_id,
    v_subscription.solidgate_order_id, 100, 'eur', 'settle_ok',
    'sub-tokenless-watermark'
  );
  ASSERT v_result = 'hosted_form';

  SELECT opened.* INTO STRICT v_card
  FROM public.open_solidgate_card_update_attempt(
    'sandbox', v_user, v_card_order,
    'tokenless-watermark@example.test', 'lt', v_card_builder
  ) AS opened;
  ASSERT public.finalize_solidgate_card_update_attempt(
    'sandbox', v_user, v_card.attempt_id, v_card_order,
    v_card_builder, '{"merchant":"watermark-card"}'::JSONB
  );
  SELECT public.claim_solidgate_card_update_attempt(
    'sandbox', v_user, v_card_order, v_card_apply
  ) INTO STRICT v_claim;
  ASSERT v_claim = 'acquired';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'card_update', v_card.attempt_id, v_card_apply,
    NULL, NULL, NULL
  );
  ASSERT v_result = 'invalid',
    'tokenless zero-auth card update created a watermark';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'card_update', v_card.attempt_id, v_card_apply,
    'token-c1', 'visa', '1111'
  );
  ASSERT v_result = 'written';

  ASSERT public.grant_solidgate_pwa_entitlement(
    'sandbox', v_subscription.order_db_id, v_user,
    'BRANDADDON_000000_SUB', 'full', NOW() + INTERVAL '30 days',
    'sub-tokenless-watermark', 'solidgate_pwa'
  );
  SELECT sync_job.* INTO STRICT v_sync
  FROM public.claim_solidgate_subscription_token_sync(
    'sandbox', 1, 300, v_user
  ) AS sync_job;
  ASSERT v_sync.status = 'processing';
  ASSERT v_sync.desired_source_id = v_card.attempt_id::TEXT;

  SELECT opened.* INTO STRICT v_watermark
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF', 3000, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto3_bundle_all', 'locale', 'lt'
    ),
    'hosted_form', v_watermark_builder,
    'tokenless-watermark@example.test', 'lt', NULL, 'auth_settle'
  ) AS opened;
  PERFORM public.finalize_solidgate_pwa_form_v2(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF', v_watermark.order_db_id,
    v_watermark.solidgate_order_id, 3000, 'eur',
    v_watermark.claim_token,
    '{"merchant":"tokenless-s2","paymentIntent":"intent-tokenless-s2","signature":"signed"}'::JSONB,
    v_watermark.bound_customer_email,
    v_watermark.bound_checkout_locale
  );
  UPDATE public.orders
  SET status = 'completed',
      solidgate_payment_status = 'settle_ok'
  WHERE id = v_watermark.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_all',
    'BRANDBUNDLE_000000_PDF', v_watermark.order_db_id,
    v_watermark.solidgate_order_id, 3000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'hosted_form';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_watermark.order_db_id, NULL,
    NULL, NULL, NULL
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token IS NULL
      AND vault.card_brand IS NULL
      AND vault.card_last4 IS NULL
      AND vault.card_source_kind = 'pwa_order'
      AND vault.card_source_id = v_watermark.order_db_id::TEXT
  ), 'newer tokenless S2 did not hide C1';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE job.payment_environment = 'sandbox'
      AND job.user_id = v_user
      AND job.solidgate_subscription_id = 'sub-tokenless-watermark'
      AND job.status = 'awaiting_token'
      AND job.claim_token IS NULL
      AND job.processing_started_at IS NULL
      AND job.desired_source_kind = 'pwa_order'
      AND job.desired_source_id = v_watermark.order_db_id::TEXT
  ), 'tokenless S2 did not atomically fence the in-flight C1 sync';

  SELECT COUNT(*) INTO v_count
  FROM public.read_claimed_solidgate_subscription_token_sync(
    'sandbox', v_user, 'sub-tokenless-watermark', v_sync.claim_token
  );
  ASSERT v_count = 0, 'old worker read C1 after the S2 watermark';
  SELECT public.complete_solidgate_subscription_token_sync(
    'sandbox', v_user, 'sub-tokenless-watermark', v_sync.claim_token,
    'card_update', v_card.attempt_id::TEXT
  ) INTO v_boolean;
  ASSERT v_boolean IS NOT TRUE,
    'old C1 worker completed after its lease was fenced';
  SELECT COUNT(*) INTO v_count
  FROM public.claim_solidgate_subscription_token_sync(
    'sandbox', 10, 300, v_user
  );
  ASSERT v_count = 0, 'tokenless generation became claimable';

  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'card_update', v_card.attempt_id, v_card_apply,
    'token-c1', 'visa', '1111'
  );
  ASSERT v_result = 'stale', 'late C1 restored the hidden token';

  -- A later entitlement boundary must recreate a missing awaiting row while
  -- the account winner is still tokenless.
  DELETE FROM public.solidgate_subscription_token_sync_jobs
  WHERE payment_environment = 'sandbox'
    AND user_id = v_user
    AND solidgate_subscription_id = 'sub-tokenless-watermark';
  UPDATE public.entitlements
  SET status = 'past_due', updated_at = NOW()
  WHERE payment_environment = 'sandbox'
    AND user_id = v_user
    AND solidgate_subscription_id = 'sub-tokenless-watermark';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE job.payment_environment = 'sandbox'
      AND job.user_id = v_user
      AND job.solidgate_subscription_id = 'sub-tokenless-watermark'
      AND job.status = 'awaiting_token'
      AND job.desired_source_id = v_watermark.order_db_id::TEXT
  ), 'late entitlement did not recreate the durable awaiting-token job';

  -- Exact partial-refund evidence is still the same captured source and may
  -- fill its token; malformed gross/net/refund combinations may not.
  UPDATE public.orders
  SET status = 'past_due',
      amount_cents = 2500,
      solidgate_refunded_amount_cents = 500,
      solidgate_payment_status = 'refunded'
  WHERE id = v_watermark.order_db_id;
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_watermark.order_db_id, NULL,
    'token-s2', 'mastercard', '2222'
  );
  ASSERT v_result = 'written',
    'same tokenless S2 did not fill after an exact partial refund/past_due transition';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token = 'token-s2'
      AND vault.card_source_id = v_watermark.order_db_id::TEXT
  );
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE job.payment_environment = 'sandbox'
      AND job.user_id = v_user
      AND job.solidgate_subscription_id = 'sub-tokenless-watermark'
      AND job.status = 'pending'
      AND job.desired_source_id = v_watermark.order_db_id::TEXT
  ), 'same-source token fill did not requeue the fenced sync job';

  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_watermark.order_db_id, NULL,
    NULL, NULL, NULL
  );
  ASSERT v_result = 'same';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token = 'token-s2'
  ), 'same-source tokenless retry wiped the filled token';
  BEGIN
    PERFORM public.write_solidgate_account_vault_monotonic(
      'sandbox', v_user, 'pwa_order', v_watermark.order_db_id, NULL,
      'different-s2-token', 'mastercard', '2222'
    );
    RAISE EXCEPTION 'same account source accepted a different non-null token';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT sync_job.* INTO STRICT v_sync
  FROM public.claim_solidgate_subscription_token_sync(
    'sandbox', 1, 300, v_user
  ) AS sync_job;
  SELECT sync_state.* INTO STRICT v_sync_state
  FROM public.read_claimed_solidgate_subscription_token_sync(
    'sandbox', v_user, 'sub-tokenless-watermark', v_sync.claim_token
  ) AS sync_state;
  ASSERT v_sync_state.card_token = 'token-s2';
  ASSERT v_sync_state.desired_source_id = v_watermark.order_db_id::TEXT;

  -- A newer saved-card charge reuses the current account token and therefore
  -- is never a fresh source watermark, even if its webhook includes AUTH data.
  SELECT opened.* INTO STRICT v_saved
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF', 2000, 'eur',
    jsonb_build_object(
      'funnel_code', 'PWA', 'funnel_variant', 'member_area',
      'session_id', 'u-' || v_user::TEXT,
      'product_slug', 'oto3_bundle_1', 'locale', 'lt'
    ),
    'saved_card', v_saved_claim,
    'tokenless-watermark@example.test', 'lt', NULL, 'auth_settle'
  ) AS opened;
  UPDATE public.orders
  SET status = 'completed', solidgate_payment_status = 'settle_ok'
  WHERE id = v_saved.order_db_id;
  v_result := public.record_solidgate_pwa_confirmed_capture(
    'sandbox', v_user, 'oto3_bundle_1',
    'BRANDBUNDLE1_000000_PDF', v_saved.order_db_id,
    v_saved.solidgate_order_id, 2000, 'eur', 'settle_ok', NULL
  );
  ASSERT v_result = 'saved_card';
  v_result := public.write_solidgate_account_vault_monotonic(
    'sandbox', v_user, 'pwa_order', v_saved.order_db_id, NULL,
    'must-not-become-source', 'visa', '9999'
  );
  ASSERT v_result = 'invalid';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token = 'token-s2'
      AND vault.card_source_id = v_watermark.order_db_id::TEXT
  ), 'saved-card PWA advanced the account watermark';
END $$;

-- Main checkout tokenless chronology must survive account promotion, canceled
-- and past_due lifecycle states, and exact partial-refund delayed token fill.
DO $$
DECLARE
  v_user UUID := 'd1000000-0000-4000-8000-000000000004';
  v_session UUID := 'd1000000-0000-4000-8000-000000000104';
  v_main RECORD;
  v_unverified RECORD;
  v_unverified_session UUID:='d1000000-0000-4000-8000-000000000105';
  v_vault_before JSONB;
  v_job_before JSONB;
  v_result TEXT;
BEGIN
  SELECT opened.* INTO STRICT v_main
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox', v_session, 'trial1', 'BRAND_000000_SUB', 500, 'eur',
    'BRAND_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND', 'funnel_variant', 'main',
      'session_id', v_session::TEXT, 'product_slug', 'trial1',
      'price_id', 'price-main-watermark'
    ),
    'd1000000-0000-4000-8000-000000000411',
    'main-watermark@example.test', 'lt', 'price-main-watermark',
    'auth_settle', v_user
  ) AS opened;
  UPDATE public.orders
  SET status = 'active',
      solidgate_payment_status = 'settle_ok',
      solidgate_subscription_id = 'sub-main-watermark',
      auth_verified_at = NOW() -- explicit authenticated-claim fixture
  WHERE id = v_main.order_db_id;

  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_session, v_main.order_db_id, v_session::TEXT,
    NULL, NULL, NULL
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.session_id = v_session
      AND vault.card_token IS NULL
      AND vault.card_source_order_id = v_main.order_db_id
      AND NOT vault.card_source_legacy
  ), 'main tokenless source was not stored in the session vault';

  UPDATE public.orders SET status = 'canceled' WHERE id = v_main.order_db_id;
  v_result := public.promote_solidgate_session_vault_monotonic(
    'sandbox', v_user, v_session
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token IS NULL
      AND vault.card_source_kind = 'main_order'
      AND vault.card_source_id = v_main.order_db_id::TEXT
  ), 'tokenless main session watermark did not promote to the account';

  -- An attacker pays in a new anonymous funnel session using this customer's
  -- email. Payment and webhook claimed_at do not authorize account-card changes.
  INSERT INTO public.sessions(id,user_id,email,locale)
    VALUES(v_unverified_session,v_user,'main-watermark@example.test','lt');
  SELECT opened.* INTO STRICT v_unverified FROM public.open_solidgate_main_checkout_v2(
    'sandbox',v_unverified_session,'trial1','BRAND_000000_SUB',500,'eur','BRAND_000000_SUB',
    jsonb_build_object('funnel_code','BRAND','funnel_variant','main','session_id',v_unverified_session::TEXT,
      'product_slug','trial1','price_id','price-unverified-main'),
    'd1000000-0000-4000-8000-000000000412','main-watermark@example.test','lt',
    'price-unverified-main','auth_settle',v_user) AS opened;
  UPDATE public.orders SET status='active',solidgate_payment_status='settle_ok',
    solidgate_subscription_id='sub-unverified-main-watermark',claimed_at=NOW()
    WHERE id=v_unverified.order_db_id;
  v_result:=public.write_solidgate_session_vault_monotonic('sandbox',v_unverified_session,
    v_unverified.order_db_id,v_unverified_session::TEXT,'unverified-card-token','visa','9999');
  ASSERT v_result='written', 'anonymous checkout may retain its own session-scoped card';
  -- A pre-existing processing sync job must keep its exact claim and desired
  -- generation; even a tokenless attacker source must not fence that worker.
  INSERT INTO public.solidgate_subscription_token_sync_jobs(payment_environment,user_id,solidgate_subscription_id,
    desired_source_kind,desired_source_created_at,desired_source_sequence,desired_source_id,status,
    claim_token,processing_started_at)
  SELECT 'sandbox',v_user,'sub-main-watermark','main_order',created_at,solidgate_card_source_sequence,id::TEXT,
    'processing','d1000000-0000-4000-8000-000000000499'::UUID,NOW()
  FROM public.orders WHERE id=v_main.order_db_id;
  SELECT to_jsonb(vault) INTO v_vault_before FROM public.solidgate_account_vault AS vault
    WHERE payment_environment='sandbox' AND user_id=v_user;
  SELECT to_jsonb(job) INTO v_job_before FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE payment_environment='sandbox' AND user_id=v_user AND solidgate_subscription_id='sub-main-watermark';
  v_result:=public.promote_solidgate_session_vault_with_method('sandbox',v_user,v_unverified_session);
  ASSERT v_result='unverified', 'paid anonymous checkout cannot promote to an existing customer account';
  v_result:=public.write_solidgate_account_vault_monotonic('sandbox',v_user,'main_order',v_unverified.order_db_id,
    NULL,'unverified-card-token','visa','9999');
  ASSERT v_result='unverified', 'direct token writer requires authenticated source ownership';
  v_result:=public.write_solidgate_account_vault_monotonic('sandbox',v_user,'main_order',v_unverified.order_db_id,
    NULL,NULL,NULL,NULL);
  ASSERT v_result='unverified', 'tokenless writer cannot advance an unverified account generation';
  ASSERT (SELECT to_jsonb(vault)=v_vault_before FROM public.solidgate_account_vault AS vault
    WHERE payment_environment='sandbox' AND user_id=v_user), 'unverified checkout changed the existing account vault';
  ASSERT (SELECT to_jsonb(job)=v_job_before FROM public.solidgate_subscription_token_sync_jobs AS job
    WHERE payment_environment='sandbox' AND user_id=v_user AND solidgate_subscription_id='sub-main-watermark'),
    'unverified checkout changed or fenced the existing token synchronization job';
  RAISE NOTICE 'UNVERIFIED MAIN CHECKOUT ACCOUNT VAULT ISOLATION PASSED';

  UPDATE public.orders
  SET status = 'past_due',
      amount_cents = 400,
      solidgate_refunded_amount_cents = 100,
      solidgate_payment_status = 'refunded'
  WHERE id = v_main.order_db_id;
  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_session, v_main.order_db_id, v_session::TEXT,
    'main-filled-token', 'visa', '4444'
  );
  ASSERT v_result = 'written';
  v_result := public.promote_solidgate_session_vault_monotonic(
    'sandbox', v_user, v_session
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.user_id = v_user
      AND vault.card_token = 'main-filled-token'
      AND vault.card_source_id = v_main.order_db_id::TEXT
  ), 'past_due partial-refund main fill did not reach the account';

  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_session, v_main.order_db_id, v_session::TEXT,
    NULL, NULL, NULL
  );
  ASSERT v_result = 'same';
  BEGIN
    PERFORM public.write_solidgate_session_vault_monotonic(
      'sandbox', v_session, v_main.order_db_id, v_session::TEXT,
      'different-main-token', 'visa', '4444'
    );
    RAISE EXCEPTION 'same main source accepted a different non-null token';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- The operator hard-zero path remains usable after the monotonic guard lands,
-- but only for a legacy row and only to the completely empty state.
DO $$
DECLARE
  v_session UUID := 'd1000000-0000-4000-8000-000000000101';
BEGIN
  ALTER TABLE public.solidgate_session_vault
    DISABLE TRIGGER guard_solidgate_session_vault_card_source_insert_trigger;
  INSERT INTO public.solidgate_session_vault (
    payment_environment, session_id, customer_account_id,
    card_token, card_brand, card_last4, card_source_legacy
  ) VALUES (
    'sandbox', v_session, v_session::TEXT,
    'legacy-clear-token', 'visa', '0101', TRUE
  );
  ALTER TABLE public.solidgate_session_vault
    ENABLE TRIGGER guard_solidgate_session_vault_card_source_insert_trigger;

  ASSERT public.clear_solidgate_legacy_session_vault('sandbox', v_session),
    'post-cutover operator legacy clear was blocked by the source guard';
  ASSERT NOT public.clear_solidgate_legacy_session_vault('sandbox', v_session),
    'operator clear reported success for an already nonlegacy empty row';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.session_id = v_session
      AND vault.card_token IS NULL
      AND vault.card_brand IS NULL
      AND vault.card_last4 IS NULL
      AND vault.card_source_order_id IS NULL
      AND vault.card_source_created_at IS NULL
      AND vault.card_source_sequence IS NULL
      AND NOT vault.card_source_legacy
  ), 'operator clear did not leave the exact empty state';
  BEGIN
    UPDATE public.solidgate_session_vault
    SET card_token = 'direct-bypass-token'
    WHERE payment_environment = 'sandbox' AND session_id = v_session;
    RAISE EXCEPTION 'direct session-vault write bypassed the monotonic guard';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
