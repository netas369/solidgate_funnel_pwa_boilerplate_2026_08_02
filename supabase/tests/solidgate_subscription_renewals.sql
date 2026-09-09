\set ON_ERROR_STOP on

-- Run only against a throwaway database with 00001_baseline.sql applied.
-- The webhook proves the paid invoice and calculates the period end before
-- calling this RPC. These tests exercise the actual persisted access changes,
-- including its replay/ownership guards; they do not substitute for those
-- provider-envelope tests.
\connect - supabase_admin

BEGIN;

INSERT INTO auth.users (id, email)
VALUES ('71000000-0000-4000-8000-000000000001', 'renewal-sql@example.test');

INSERT INTO public.sessions (id, user_id, email, locale)
VALUES
  ('71000000-0000-4000-8000-000000000101',
   '71000000-0000-4000-8000-000000000001', 'renewal-sql@example.test', 'en'),
  ('71000000-0000-4000-8000-000000000102',
   '71000000-0000-4000-8000-000000000001', 'renewal-sql@example.test', 'en');

-- Keep canonical checkout identities and all production triggers enabled.
-- The same provider subscription id in each environment is intentional:
-- neither the lifecycle write nor entitlement lookup may cross environments.
INSERT INTO public.orders (
  id, psp, payment_environment, session_id, user_id, solidgate_order_id,
  product_name, product_slug, status, amount_cents, currency,
  solidgate_original_amount_cents, solidgate_payment_status,
  solidgate_subscription_id, tracking_metadata, solidgate_customer_email,
  solidgate_checkout_locale, solidgate_product_id, solidgate_payment_action,
  solidgate_checkout_identity_bound_at, created_at
)
SELECT
  CASE environment
    WHEN 'sandbox' THEN '71000000-0000-4000-8000-000000000201'::UUID
    ELSE '71000000-0000-4000-8000-000000000204'::UUID
  END,
  'solidgate', environment,
  '71000000-0000-4000-8000-000000000101'::UUID,
  '71000000-0000-4000-8000-000000000001'::UUID,
  '71000000-0000-4000-8000-000000000101:trial1:1',
  'BRAND_000000_SUB', 'BRAND_000000_SUB', 'trialing', 500, 'usd',
  500, 'settle_ok', 'sub-renewal-main',
  '{"funnel_code":"BRAND","funnel_variant":"main","session_id":"71000000-0000-4000-8000-000000000101","product_slug":"trial1","price_id":"price-renewal-main"}'::JSONB,
  'renewal-sql@example.test', 'en', 'price-renewal-main', 'auth_settle',
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days'
FROM (VALUES ('sandbox'), ('production')) AS environments(environment);

INSERT INTO public.orders (
  id, psp, payment_environment, user_id, solidgate_order_id,
  product_name, product_slug, status, amount_cents, currency,
  solidgate_original_amount_cents, solidgate_payment_status,
  solidgate_subscription_id, tracking_metadata, solidgate_customer_email,
  solidgate_checkout_locale, solidgate_product_id, solidgate_payment_action,
  solidgate_checkout_identity_bound_at, created_at
)
VALUES (
  '71000000-0000-4000-8000-000000000202', 'solidgate', 'sandbox',
  '71000000-0000-4000-8000-000000000001',
  'u-71000000-0000-4000-8000-000000000001:oto2_addon_weekly:1',
  'BRANDADDON_000000_SUB', 'BRANDADDON_000000_SUB', 'active', 100, 'eur',
  100, 'settle_ok', 'sub-renewal-addon',
  '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-71000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-renewal-addon"}'::JSONB,
  'renewal-sql@example.test', 'en', 'price-renewal-addon', 'auth_settle',
  NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days'
);

INSERT INTO public.entitlements (
  payment_environment, user_id, product_slug, order_id,
  solidgate_subscription_id, status, access_level, expires_at, source
)
SELECT
  payment_environment, user_id, product_slug, id, solidgate_subscription_id,
  'active', CASE WHEN product_slug = 'BRAND_000000_SUB' THEN 'trial' ELSE 'full' END,
  NOW() - INTERVAL '7 days', 'solidgate_grant'
FROM public.orders
WHERE id IN (
  '71000000-0000-4000-8000-000000000201',
  '71000000-0000-4000-8000-000000000202',
  '71000000-0000-4000-8000-000000000204'
);

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_user UUID := '71000000-0000-4000-8000-000000000001';
  v_main UUID := '71000000-0000-4000-8000-000000000201';
  v_addon UUID := '71000000-0000-4000-8000-000000000202';
  v_replacement UUID := '71000000-0000-4000-8000-000000000203';
  v_production UUID := '71000000-0000-4000-8000-000000000204';
  v_main_end TIMESTAMPTZ := NOW() + INTERVAL '30 days';
  v_addon_end TIMESTAMPTZ := NOW() + INTERVAL '7 days';
  v_result TEXT;
  v_before JSONB;
  v_after JSONB;
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE user_id = v_user AND expires_at > NOW()
  ), 'renewal fixture unexpectedly starts with unexpired access';

  -- An actual main rebill replaces the expired trial with the paid period.
  UPDATE public.orders SET status = 'active' WHERE id = v_main;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', format('main renewal returned %s', v_result);
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements
    WHERE payment_environment = 'sandbox' AND user_id = v_user
      AND product_slug = 'BRAND_000000_SUB' AND order_id = v_main
      AND solidgate_subscription_id = 'sub-renewal-main'
      AND status = 'active' AND access_level = 'full' AND revoked_at IS NULL
      AND expires_at = v_main_end AND expires_at > NOW()
      AND source = 'solidgate_webhook'
  ), 'paid main renewal did not grant its complete period';

  -- Duplicate delivery is not an extra 30 days and cannot create another row.
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'duplicate main renewal was not accepted';
  ASSERT (
    SELECT COUNT(*) = 1 AND MIN(expires_at) = v_main_end
    FROM public.entitlements WHERE order_id = v_main
  ), 'duplicate renewal duplicated access or added another billing period';

  -- The initial browser grant must not shorten the renewed period to its old
  -- seven-day fallback, even when the buyer revisits the checkout return URL.
  ASSERT public.grant_solidgate_main_entitlement(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main', 500,
    NOW() - INTERVAL '7 days'
  ), 'initial grant replay did not recognize the renewed main subscription';
  ASSERT (SELECT expires_at = v_main_end FROM public.entitlements WHERE order_id = v_main),
    'initial grant replay shortened the renewed main period';

  -- Grace is a temporary access policy, not purchased time. Recovery uses the
  -- paid invoice period even if a generous grace deadline would end later.
  UPDATE public.orders SET status = 'past_due' WHERE id = v_main;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'grace', 'past_due', v_main_end + INTERVAL '3 days', 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'main grace transition was not accepted';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements WHERE order_id = v_main
      AND status = 'past_due' AND access_level = 'grace'
      AND expires_at = v_main_end + INTERVAL '3 days'
  ), 'main grace deadline fixture was not persisted';
  UPDATE public.orders SET status = 'active' WHERE id = v_main;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'main recovery from grace was not accepted';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements WHERE order_id = v_main
      AND status = 'active' AND access_level = 'full' AND expires_at = v_main_end
  ), 'paid recovery incorrectly retained the longer grace deadline';

  -- Positive callbacks can arrive late after a newer paid term. Only a
  -- transition out of grace may shorten its policy deadline: an already paid
  -- active term must not lose time or be downgraded to the initial trial.
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end - INTERVAL '1 day', 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'older active callback was not handled';
  ASSERT (SELECT expires_at = v_main_end FROM public.entitlements WHERE order_id = v_main),
    'older active callback shortened the paid subscription period';
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'trial', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'late trial callback was not handled';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements WHERE order_id = v_main
      AND status = 'active' AND access_level = 'full' AND expires_at = v_main_end
  ), 'late trial callback downgraded full paid access';

  -- Weekly add-on dunning denies access without an irreversible tombstone.
  UPDATE public.orders SET status = 'past_due' WHERE id = v_addon;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_addon, v_user, 'BRANDADDON_000000_SUB', 'sub-renewal-addon',
    'full', 'past_due', NOW() - INTERVAL '1 day', 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'add-on dunning was not persisted';
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements WHERE order_id = v_addon
      AND status = 'past_due' AND access_level = 'full'
      AND revoked_at IS NULL AND expires_at < NOW()
  ), 'add-on dunning did not leave recoverable, inactive access';
  UPDATE public.orders SET status = 'active' WHERE id = v_addon;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_addon, v_user, 'BRANDADDON_000000_SUB', 'sub-renewal-addon',
    'full', 'active', v_addon_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', format('paid add-on recovery returned %s', v_result);
  ASSERT EXISTS (
    SELECT 1 FROM public.entitlements WHERE order_id = v_addon
      AND status = 'active' AND access_level = 'full' AND revoked_at IS NULL
      AND expires_at = v_addon_end AND expires_at > NOW()
  ), 'paid add-on recovery did not restore the full paid week';
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_addon, v_user, 'BRANDADDON_000000_SUB', 'sub-renewal-addon',
    'full', 'active', v_addon_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'applied', 'duplicate add-on recovery was not accepted';
  ASSERT (
    SELECT COUNT(*) = 1 AND MIN(expires_at) = v_addon_end
    FROM public.entitlements WHERE order_id = v_addon
  ), 'duplicate add-on recovery added access beyond the paid week';

  -- A valid provider subscription id cannot compensate for the wrong local
  -- environment. Check both persisted rows, not just the RPC return value.
  SELECT jsonb_agg(to_jsonb(entitlement) ORDER BY entitlement.id) INTO v_before
  FROM public.entitlements AS entitlement WHERE user_id = v_user;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'production', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'invalid', 'sandbox order was accepted for a production renewal';
  SELECT jsonb_agg(to_jsonb(entitlement) ORDER BY entitlement.id) INTO v_after
  FROM public.entitlements AS entitlement WHERE user_id = v_user;
  ASSERT v_after = v_before, 'environment mismatch mutated an entitlement';

  -- A newer checkout may own the same product. A late callback still bound to
  -- the older subscription must not steal that owner or replace its expiry.
  INSERT INTO public.orders (
    id, psp, payment_environment, session_id, user_id, solidgate_order_id,
    product_name, product_slug, status, amount_cents, currency,
    solidgate_original_amount_cents, solidgate_payment_status,
    solidgate_subscription_id, tracking_metadata, solidgate_customer_email,
    solidgate_checkout_locale, solidgate_product_id, solidgate_payment_action,
    solidgate_checkout_identity_bound_at, created_at
  ) VALUES (
    v_replacement, 'solidgate', 'sandbox',
    '71000000-0000-4000-8000-000000000102', v_user,
    '71000000-0000-4000-8000-000000000102:trial1:1',
    'BRAND_000000_SUB', 'BRAND_000000_SUB', 'trialing', 500, 'usd',
    500, 'settle_ok', 'sub-renewal-replacement',
    '{"funnel_code":"BRAND","funnel_variant":"main","session_id":"71000000-0000-4000-8000-000000000102","product_slug":"trial1","price_id":"price-renewal-main"}'::JSONB,
    'renewal-sql@example.test', 'en', 'price-renewal-main', 'auth_settle',
    NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'
  );
  ASSERT public.grant_solidgate_main_entitlement(
    'sandbox', v_replacement, v_user, 'BRAND_000000_SUB',
    'sub-renewal-replacement', 500, NOW() + INTERVAL '6 days'
  ), 'newer subscription could not acquire entitlement ownership';
  SELECT to_jsonb(entitlement) INTO v_before FROM public.entitlements AS entitlement
  WHERE order_id = v_replacement;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_main, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'stale', 'older subscription callback was not rejected as stale';
  SELECT to_jsonb(entitlement) INTO v_after FROM public.entitlements AS entitlement
  WHERE order_id = v_replacement;
  ASSERT v_after = v_before, 'older renewal changed the replacement subscription';

  -- Hard revocations retain the same-order replay barrier. Recovery above is
  -- specifically for past_due access with no tombstone.
  UPDATE public.entitlements SET status = 'canceled', revoked_at = NOW()
  WHERE order_id = v_replacement;
  SELECT to_jsonb(entitlement) INTO v_before FROM public.entitlements AS entitlement
  WHERE order_id = v_replacement;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'sandbox', v_replacement, v_user, 'BRAND_000000_SUB',
    'sub-renewal-replacement', 'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'lifecycle_owned', 'renewal cleared a cancellation tombstone';
  SELECT to_jsonb(entitlement) INTO v_after FROM public.entitlements AS entitlement
  WHERE order_id = v_replacement;
  ASSERT v_after = v_before, 'renewal modified a revoked entitlement';

  -- Reversed money blocks access even when the entitlement has not yet been
  -- tombstoned by the refund handler. The original gross remains immutable.
  UPDATE public.orders
  SET status = 'refunded', amount_cents = 0,
      solidgate_refunded_amount_cents = 500, solidgate_payment_status = 'refunded'
  WHERE id = v_production;
  SELECT to_jsonb(entitlement) INTO v_before FROM public.entitlements AS entitlement
  WHERE order_id = v_production;
  v_result := public.apply_solidgate_subscription_entitlement_lifecycle(
    'production', v_production, v_user, 'BRAND_000000_SUB', 'sub-renewal-main',
    'full', 'active', v_main_end, 'solidgate_webhook'
  );
  ASSERT v_result = 'reversed', 'refunded order was allowed to extend access';
  SELECT to_jsonb(entitlement) INTO v_after FROM public.entitlements AS entitlement
  WHERE order_id = v_production;
  ASSERT v_after = v_before, 'refunded order changed access before its tombstone';

  RAISE NOTICE 'SOLIDGATE SUBSCRIPTION RENEWAL SCENARIOS PASSED';
END $$;

ROLLBACK;

\echo SOLIDGATE SUBSCRIPTION RENEWAL TESTS PASSED
