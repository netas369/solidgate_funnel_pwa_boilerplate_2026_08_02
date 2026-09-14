\set ON_ERROR_STOP on
\ir helpers/clear_financial_test_orders.sql
\if :{?round2_dblink_conn}
\else
\set round2_dblink_conn 'host=127.0.0.1 port=5432 user=postgres'
\endif
SELECT pg_catalog.set_config('finance.dblink_conn',:'round2_dblink_conn',FALSE) AS finance_connection
\gset
SELECT pg_temp.clear_solidgate_financial_test_orders(ARRAY(SELECT id FROM public.orders WHERE user_id='82000000-0000-4000-8000-000000000001')) AS finance_cleaned
\gset
DELETE FROM public.entitlements WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM public.orders WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM public.sessions WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id='82000000-0000-4000-8000-000000000001';
\set ON_ERROR_STOP on

-- Run only against a throwaway database with 00001_baseline.sql applied.
-- The webhook proves the paid invoice and calculates the period end before
-- calling this RPC. These tests exercise the actual persisted access changes,
-- including its replay/ownership guards; they do not substitute for those
-- provider-envelope tests.




INSERT INTO auth.users (id, email)
VALUES ('82000000-0000-4000-8000-000000000001', 'finance-concurrency@example.test');

INSERT INTO public.sessions (id, user_id, email, locale)
VALUES
  ('82000000-0000-4000-8000-000000000101',
   '82000000-0000-4000-8000-000000000001', 'finance-concurrency@example.test', 'en'),
  ('82000000-0000-4000-8000-000000000102',
   '82000000-0000-4000-8000-000000000001', 'finance-concurrency@example.test', 'en');

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
    WHEN 'sandbox' THEN '82000000-0000-4000-8000-000000000201'::UUID
    ELSE '82000000-0000-4000-8000-000000000204'::UUID
  END,
  'solidgate', environment,
  '82000000-0000-4000-8000-000000000101'::UUID,
  '82000000-0000-4000-8000-000000000001'::UUID,
  '82000000-0000-4000-8000-000000000101:trial1:1',
  'BRAND_000000_SUB', 'BRAND_000000_SUB', 'trialing', 500, 'usd',
  500, 'settle_ok', 'sub-finance-concurrent',
  '{"funnel_code":"BRAND","funnel_variant":"main","session_id":"82000000-0000-4000-8000-000000000101","product_slug":"trial1","price_id":"price-renewal-main"}'::JSONB,
  'finance-concurrency@example.test', 'en', 'price-renewal-main', 'auth_settle',
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
  '82000000-0000-4000-8000-000000000202', 'solidgate', 'sandbox',
  '82000000-0000-4000-8000-000000000001',
  'u-82000000-0000-4000-8000-000000000001:oto2_addon_weekly:1',
  'BRANDADDON_000000_SUB', 'BRANDADDON_000000_SUB', 'active', 100, 'eur',
  100, 'settle_ok', 'sub-finance-concurrent-addon',
  '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-82000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-renewal-addon"}'::JSONB,
  'finance-concurrency@example.test', 'en', 'price-renewal-addon', 'auth_settle',
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
  '82000000-0000-4000-8000-000000000201',
  '82000000-0000-4000-8000-000000000202',
  '82000000-0000-4000-8000-000000000204'
);

DO $$
DECLARE
  v_result JSONB;
  v_connection TEXT:=pg_catalog.current_setting('finance.dblink_conn')||' dbname='||pg_catalog.current_database();
  v_facts JSONB:='{"order_db_id":"82000000-0000-4000-8000-000000000201","currency":"usd","quoted_amount_cents":500,"subscription_id":"sub-finance-concurrent","occurred_at":"2026-09-02T00:00:00Z"}';
  v_provider TEXT:='82000000-0000-4000-8000-000000000101:trial1:1';
BEGIN
  PERFORM extensions.dblink_connect('finance-capture',v_connection);
  PERFORM extensions.dblink_connect('finance-refund',v_connection);
  PERFORM extensions.dblink_exec('finance-capture','SET ROLE service_role');
  PERFORM extensions.dblink_exec('finance-refund','SET ROLE service_role');
  PERFORM extensions.dblink_exec('finance-capture','BEGIN');
  SELECT result::JSONB INTO v_result FROM extensions.dblink('finance-capture',format(
    'SELECT public.apply_solidgate_financial_event(%L,%L,%L,%L::JSONB)::TEXT',
    'sandbox','concurrent-capture',v_provider,v_facts||'{"captured_amount_cents":500,"payment_status":"settle_ok"}'::JSONB)) AS value(result TEXT);
  ASSERT (v_result->>'captured_amount_cents')::INTEGER=500;
  PERFORM extensions.dblink_send_query('finance-refund',format(
    'SELECT public.apply_solidgate_financial_event(%L,%L,%L,%L::JSONB)::TEXT',
    'sandbox','concurrent-refund',v_provider,v_facts||'{"refunded_amount_cents":100}'::JSONB));
  PERFORM pg_sleep(0.05);
  ASSERT extensions.dblink_is_busy('finance-refund')=1,'refund must wait for uncommitted capture on the same payment';
  PERFORM extensions.dblink_exec('finance-capture','COMMIT');
  SELECT result::JSONB INTO v_result FROM extensions.dblink_get_result('finance-refund') AS value(result TEXT);
  PERFORM * FROM extensions.dblink_get_result('finance-refund') AS value(result TEXT);
  ASSERT (v_result->>'net_amount_cents')::INTEGER=400,'refund after lock must see committed capture';
  ASSERT (SELECT captured_amount_cents=500 AND refunded_amount_cents=100 AND net_amount_cents=400
    FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider);

  PERFORM extensions.dblink_exec('finance-capture','BEGIN');
  SELECT result::JSONB INTO v_result FROM extensions.dblink('finance-capture',format(
    'SELECT public.apply_solidgate_financial_event(%L,%L,%L,%L::JSONB)::TEXT',
    'sandbox','concurrent-larger-refund',v_provider,v_facts||'{"refunded_amount_cents":300}'::JSONB)) AS value(result TEXT);
  PERFORM extensions.dblink_send_query('finance-refund',format(
    'SELECT public.apply_solidgate_financial_event(%L,%L,%L,%L::JSONB)::TEXT',
    'sandbox','concurrent-smaller-refund',v_provider,v_facts||'{"refunded_amount_cents":200}'::JSONB));
  PERFORM pg_sleep(0.05);
  ASSERT extensions.dblink_is_busy('finance-refund')=1,'independent refund snapshots share the same lock';
  PERFORM extensions.dblink_exec('finance-capture','COMMIT');
  SELECT result::JSONB INTO v_result FROM extensions.dblink_get_result('finance-refund') AS value(result TEXT);
  PERFORM * FROM extensions.dblink_get_result('finance-refund') AS value(result TEXT);
  ASSERT (v_result->>'refunded_amount_cents')::INTEGER=300 AND (v_result->>'refunded_delta_cents')::INTEGER=0,'later concurrent smaller refund cannot regress state';
  ASSERT (SELECT SUM(captured_delta_cents)=500 AND SUM(refunded_delta_cents)=300 AND SUM(net_delta_cents)=200
    FROM public.solidgate_financial_movements WHERE environment='sandbox' AND solidgate_order_id=v_provider),'concurrent cash movements conserve exactly';
  PERFORM extensions.dblink_disconnect('finance-capture');
  PERFORM extensions.dblink_disconnect('finance-refund');
  RAISE NOTICE 'FINANCIAL CAPTURE/REFUND CONCURRENCY PASSED';
EXCEPTION WHEN OTHERS THEN
  BEGIN PERFORM extensions.dblink_disconnect('finance-capture'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM extensions.dblink_disconnect('finance-refund'); EXCEPTION WHEN OTHERS THEN NULL; END;
  RAISE;
END;
$$;
SELECT pg_temp.clear_solidgate_financial_test_orders(ARRAY(SELECT id FROM public.orders WHERE user_id='82000000-0000-4000-8000-000000000001')) AS finance_cleaned
\gset
DELETE FROM public.entitlements WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM public.orders WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM public.sessions WHERE user_id='82000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id='82000000-0000-4000-8000-000000000001';
\echo FINANCIAL CONCURRENCY CLEANUP PASSED
