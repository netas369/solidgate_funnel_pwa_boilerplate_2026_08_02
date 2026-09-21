\set ON_ERROR_STOP on

-- Run only against a throwaway database with 00001_baseline.sql applied.
-- The webhook proves the paid invoice and calculates the period end before
-- calling this RPC. These tests exercise the actual persisted access changes,
-- including its replay/ownership guards; they do not substitute for those
-- provider-envelope tests.
\connect - supabase_admin

BEGIN;

INSERT INTO auth.users (id, email)
VALUES ('81000000-0000-4000-8000-000000000001', 'finance-sql@example.test');

INSERT INTO public.sessions (id, user_id, email, locale)
VALUES
  ('81000000-0000-4000-8000-000000000101',
   '81000000-0000-4000-8000-000000000001', 'finance-sql@example.test', 'en'),
  ('81000000-0000-4000-8000-000000000102',
   '81000000-0000-4000-8000-000000000001', 'finance-sql@example.test', 'en');

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
    WHEN 'sandbox' THEN '81000000-0000-4000-8000-000000000201'::UUID
    ELSE '81000000-0000-4000-8000-000000000204'::UUID
  END,
  'solidgate', environment,
  '81000000-0000-4000-8000-000000000101'::UUID,
  '81000000-0000-4000-8000-000000000001'::UUID,
  '81000000-0000-4000-8000-000000000101:trial1:1',
  'BRAND_000000_SUB', 'BRAND_000000_SUB', 'trialing', 500, 'usd',
  500, 'settle_ok', 'sub-finance-main',
  '{"funnel_code":"BRAND","funnel_variant":"main","session_id":"81000000-0000-4000-8000-000000000101","product_slug":"trial1","price_id":"price-renewal-main"}'::JSONB,
  'finance-sql@example.test', 'en', 'price-renewal-main', 'auth_settle',
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
  '81000000-0000-4000-8000-000000000202', 'solidgate', 'sandbox',
  '81000000-0000-4000-8000-000000000001',
  'u-81000000-0000-4000-8000-000000000001:oto2_addon_weekly:1',
  'BRANDADDON_000000_SUB', 'BRANDADDON_000000_SUB', 'active', 100, 'eur',
  100, 'settle_ok', 'sub-finance-addon',
  '{"funnel_code":"PWA","funnel_variant":"member_area","session_id":"u-81000000-0000-4000-8000-000000000001","product_slug":"oto2_addon_weekly","price_id":"price-renewal-addon"}'::JSONB,
  'finance-sql@example.test', 'en', 'price-renewal-addon', 'auth_settle',
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
  '81000000-0000-4000-8000-000000000201',
  '81000000-0000-4000-8000-000000000202',
  '81000000-0000-4000-8000-000000000204'
);

SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_order UUID := '81000000-0000-4000-8000-000000000201';
  v_provider TEXT := '81000000-0000-4000-8000-000000000101:trial1:1';
  v_facts JSONB;
  v_result JSONB;
  v_balance public.solidgate_payment_balances%ROWTYPE;
  v_analytics JSONB := '{"event_key":"finance-refund-100","event_name":"refund_issued","distinct_id":"finance-user","insert_id":"81000000-0000-4000-8000-000000000888","properties":{}}';
BEGIN
  v_facts := jsonb_build_object('order_db_id',v_order,'currency','usd','quoted_amount_cents',500,'subscription_id','sub-finance-main');
  PERFORM public.apply_solidgate_financial_event('sandbox','refund-first',v_provider,
    v_facts || '{"refunded_amount_cents":100,"payment_status":"refunded","occurred_at":"2026-09-02T00:00:00Z"}',v_analytics);
  ASSERT (SELECT needs_reconciliation AND captured_amount_cents=0 AND refunded_amount_cents=100
    FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'refund before capture is preserved for reconciliation';
  PERFORM public.apply_solidgate_financial_event('sandbox','capture-late',v_provider,
    v_facts || '{"captured_amount_cents":500,"payment_status":"settle_ok","occurred_at":"2026-09-01T00:00:00Z","occurred_at_source":"provider_operation"}');
  ASSERT (SELECT captured_amount_cents=500 AND refunded_amount_cents=100 AND net_amount_cents=400 AND NOT needs_reconciliation
    FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'late capture preserves earlier refund';
  ASSERT (SELECT amount_cents=400 AND status='trialing' FROM public.orders WHERE id=v_order), 'late partial refund does not tombstone access';
  PERFORM public.apply_solidgate_financial_event('sandbox','old-refund',v_provider,v_facts || '{"refunded_amount_cents":50,"occurred_at":"2026-09-02T00:00:00Z"}');
  ASSERT (SELECT refunded_amount_cents=100 AND net_amount_cents=400 FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'cumulative refund cannot regress at equal timestamp';
  v_result := public.apply_solidgate_financial_event('sandbox','refund-first',v_provider,v_facts || '{"refunded_amount_cents":100}',v_analytics);
  ASSERT (v_result->>'applied')::BOOLEAN=FALSE AND (v_result->>'refunded_delta_cents')::INTEGER=100, 'replay returns original immutable delta';
  ASSERT (SELECT (properties->>'revenue')::NUMERIC=-100 AND (properties->>'refund_amount_cents')::NUMERIC=100
    FROM public.solidgate_analytics_outbox WHERE environment='sandbox' AND event_key='finance-refund-100'), 'outbox contains original refund delta';
  ASSERT (SELECT SUM(net_delta_cents)=400 AND SUM(captured_delta_cents)=500 AND SUM(refunded_delta_cents)=100
    FROM public.solidgate_financial_movements WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'ledger cash conserves independently of arrival order';
  ASSERT (SELECT SUM(net_delta_cents)=-100 FROM public.solidgate_financial_movements
    WHERE environment='sandbox' AND solidgate_order_id=v_provider AND occurred_at='2026-09-02T00:00:00Z'), 'refund keeps its cash date';
  BEGIN
    PERFORM public.apply_solidgate_financial_event('sandbox','rollback-refund',v_provider,
      v_facts || '{"refunded_amount_cents":200}',v_analytics || '{"event_key":"finance-invalid-outbox","insert_id":"invalid-uuid"}');
    RAISE EXCEPTION 'invalid analytics should fail';
  EXCEPTION WHEN invalid_text_representation THEN NULL; END;
  ASSERT (SELECT refunded_amount_cents=100 FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'outbox failure rolls back balance and movement';
  ASSERT NOT EXISTS(SELECT 1 FROM public.solidgate_financial_movements WHERE event_key='rollback-refund'), 'failed transaction did not consume event id';
  PERFORM public.apply_solidgate_financial_event('sandbox','dispute',v_provider,
    v_facts || '{"chargeback_id":"cb-finance","chargeback_status":"in_progress","chargeback_amount_cents":500,"occurred_at":"2026-09-03T00:00:00Z"}');
  PERFORM public.apply_solidgate_financial_event('sandbox','refund-after-dispute',v_provider,
    v_facts || '{"refunded_amount_cents":200,"occurred_at":"2026-09-04T00:00:00Z"}');
  ASSERT (SELECT net_amount_cents=0 AND chargeback_amount_cents=500 AND refunded_amount_cents=200
    FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'refund cannot resurrect disputed money';
  ASSERT (SELECT amount_cents=0 AND status='disputed' FROM public.orders WHERE id=v_order), 'order keeps dispute barrier';
  PERFORM public.apply_solidgate_financial_event('sandbox','dispute-reversed',v_provider,
    v_facts || '{"chargeback_id":"cb-finance","chargeback_status":"resolved_reversal","chargeback_amount_cents":500,"occurred_at":"2026-09-05T00:00:00Z"}');
  PERFORM public.apply_solidgate_financial_event('sandbox','old-dispute',v_provider,
    v_facts || '{"chargeback_id":"cb-finance","chargeback_status":"in_progress","chargeback_amount_cents":500,"occurred_at":"2026-09-05T00:00:00Z"}');
  ASSERT (SELECT net_amount_cents=300 AND chargeback_amount_cents=0 FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'equal-time reversal outranks open dispute';
  ASSERT (SELECT SUM(net_delta_cents)=300 FROM public.solidgate_financial_movements WHERE environment='sandbox' AND solidgate_order_id=v_provider), 'chargeback/reversal/refund conserve cash';
  -- Renewal refund may arrive before both invoice projection and capture.
  v_facts := v_facts || '{"invoice_id":"finance-invoice-1","subscription_term_number":1,"quoted_amount_cents":5900,"period_start_at":"2026-09-01T00:00:00Z","period_end_at":"2026-10-01T00:00:00Z"}';
  PERFORM public.apply_solidgate_financial_event('sandbox','renewal-refund-first','finance-renewal-order',v_facts || '{"refunded_amount_cents":5900,"occurred_at":"2026-09-03T00:00:00Z"}');
  PERFORM public.apply_solidgate_financial_event('sandbox','renewal-capture-late','finance-renewal-order',v_facts || '{"captured_amount_cents":5900,"payment_status":"settle_ok","occurred_at":"2026-09-02T00:00:00Z"}');
  ASSERT (SELECT amount_cents=0 AND gross_amount_cents=5900 AND refunded_amount_cents=5900 AND status='refunded'
    FROM public.renewal_events WHERE payment_environment='sandbox' AND solidgate_invoice_id='finance-invoice-1'), 'renewal cannot reappear as paid after full refund';
  ASSERT (SELECT refunded_amount_cents=5900 AND status='refunded' FROM public.solidgate_invoice_orders
    WHERE environment='sandbox' AND solidgate_order_id='finance-renewal-order'), 'mapping keeps refund evidence';
  -- Actual undercapture stays separate from its immutable quote.
  v_facts := v_facts || '{"invoice_id":"finance-invoice-2","subscription_term_number":2}';
  PERFORM public.apply_solidgate_financial_event('sandbox','partial-capture','finance-partial-order',v_facts || '{"captured_amount_cents":1200,"payment_status":"partial_settled","occurred_at":"2026-09-02T00:00:00Z"}');
  PERFORM public.apply_solidgate_financial_event('sandbox','partial-full-refund','finance-partial-order',v_facts || '{"refunded_amount_cents":1200,"occurred_at":"2026-09-03T00:00:00Z"}');
  ASSERT (SELECT captured_amount_cents=1200 AND quoted_amount_cents=5900 AND net_amount_cents=0 FROM public.solidgate_payment_balances
    WHERE environment='sandbox' AND solidgate_order_id='finance-partial-order'), 'full refund is based on actual partial capture';
  ASSERT (SELECT status='refunded' AND gross_amount_cents=1200 AND amount_cents=0 FROM public.renewal_events
    WHERE payment_environment='sandbox' AND solidgate_invoice_id='finance-invoice-2'), 'undercapture renewal gross is actual collection';
  v_facts:=v_facts||'{"invoice_id":"finance-invoice-3","subscription_term_number":3,"quoted_amount_cents":1767}';
  PERFORM public.apply_solidgate_financial_event('sandbox','capture-tx-first','finance-tx-order',v_facts||
    '{"captured_amount_cents":1200,"capture_transactions":[{"id":"tx-a","amount_cents":1200,"currency":"USD","occurred_at":"2026-09-01T00:00:00Z"}]}');
  PERFORM public.apply_solidgate_financial_event('sandbox','capture-tx-second','finance-tx-order',v_facts||
    '{"captured_amount_cents":567,"capture_transactions":[{"id":"tx-b","amount_cents":567,"currency":"USD","occurred_at":"2026-09-02T00:00:00Z"}]}');
  PERFORM public.apply_solidgate_financial_event('sandbox','capture-tx-replay','finance-tx-order',v_facts||
    '{"captured_amount_cents":567,"capture_transactions":[{"id":"tx-b","amount_cents":567,"currency":"USD","occurred_at":"2026-09-02T00:00:00Z"}]}');
  ASSERT (SELECT captured_amount_cents=1767 FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id='finance-tx-order'), 'separate successful transactions sum once';
  ASSERT (SELECT COUNT(*)=2 FROM public.solidgate_capture_transactions WHERE environment='sandbox' AND solidgate_order_id='finance-tx-order'), 'transaction replay is idempotent';
  BEGIN
    PERFORM public.apply_solidgate_financial_event('sandbox','capture-tx-conflict','finance-tx-order',v_facts||
      '{"capture_transactions":[{"id":"tx-b","amount_cents":999}]}');
    RAISE EXCEPTION 'transaction amount mutation should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.solidgate_invoice_orders(environment,solidgate_order_id,solidgate_invoice_id,
    solidgate_subscription_id,subscription_term_number,status,amount_cents,currency,refunded_amount_cents)
  VALUES('sandbox','finance-legacy-refunded','finance-invoice-4','sub-finance-main',4,'refunded',5900,'usd',5900);
  PERFORM public.apply_solidgate_financial_event('sandbox','legacy-late-paid','finance-legacy-refunded',v_facts||
    '{"invoice_id":"finance-invoice-4","subscription_term_number":4,"quoted_amount_cents":5900,"captured_amount_cents":5900,"payment_status":"settle_ok"}');
  ASSERT (SELECT status='refunded' AND amount_cents=0 AND refunded_amount_cents=5900 FROM public.renewal_events
    WHERE payment_environment='sandbox' AND solidgate_invoice_id='finance-invoice-4'), 'pre-upgrade refunded mapping survives first financial projection';
  ASSERT NOT EXISTS (SELECT 1 FROM public.solidgate_payment_balances WHERE environment='production'), 'sandbox cash never crosses environments';
  RAISE NOTICE 'FINANCIAL EVENT PERMUTATIONS PASSED';
END;
$$;

DO $$
DECLARE
  v_user UUID := '81000000-0000-4000-8000-000000000001';
  v_order UUID := '81000000-0000-4000-8000-000000000202';
  v_cancel TIMESTAMPTZ := NOW()-INTERVAL '1 hour';
  v_restore TIMESTAMPTZ := NOW();
  v_expiry TIMESTAMPTZ := NOW()+INTERVAL '30 days';
  v_result TEXT;
BEGIN
  PERFORM public.apply_solidgate_financial_event('sandbox','restore-paid','finance-restorable-order',
    jsonb_build_object('order_db_id',v_order,'currency','eur','subscription_id','sub-finance-addon',
      'invoice_id','finance-restorable-invoice','subscription_term_number',1,'captured_amount_cents',10000,
      'occurred_at',v_cancel-INTERVAL '1 day','period_end_at',v_expiry));
  PERFORM public.record_solidgate_subscription_snapshot('sandbox','cancel-source',v_order,'sub-finance-addon',
    'cancel',v_cancel,jsonb_build_object('status','canceled','cancelled_at',v_cancel,'trial',FALSE));
  UPDATE public.orders SET status='canceled' WHERE id=v_order;
  UPDATE public.entitlements SET status='canceled',revoked_at=v_cancel WHERE order_id=v_order;
  BEGIN
    UPDATE public.entitlements SET status='active',revoked_at=NULL WHERE order_id=v_order;
    RAISE EXCEPTION 'direct restore should fail';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='direct restore should fail' THEN RAISE; END IF;
  END;
  PERFORM public.record_solidgate_subscription_snapshot('sandbox','restore-source',v_order,'sub-finance-addon',
    'restore',v_restore,jsonb_build_object('status','active','trial',FALSE,'period_end_at',v_expiry));
  v_result:=public.restore_solidgate_subscription_entitlement('sandbox',v_order,v_user,'BRANDADDON_000000_SUB',
    'sub-finance-addon','full',v_expiry,'restore-source',v_restore);
  ASSERT v_result='applied', 'newer exact restore with verified paid period must work';
  ASSERT (SELECT revoked_at IS NULL AND status='active' AND expires_at=v_expiry FROM public.entitlements WHERE order_id=v_order), 'restore reinstates paid period';
  ASSERT (SELECT status='active' FROM public.orders WHERE id=v_order), 'restore reactivates the owning order';
  PERFORM public.apply_solidgate_financial_event('sandbox','restored-period-refunded','finance-restorable-order',
    jsonb_build_object('order_db_id',v_order,'currency','eur','subscription_id','sub-finance-addon',
      'invoice_id','finance-restorable-invoice','subscription_term_number',1,'refunded_amount_cents',10000,'occurred_at',v_restore));
  v_result:=public.apply_solidgate_subscription_entitlement_lifecycle('sandbox',v_order,v_user,'BRANDADDON_000000_SUB',
    'sub-finance-addon','full','active',v_expiry,'solidgate_renew');
  ASSERT v_result='reversed', 'lifecycle RPC rechecks reversed invoice atomically';
  ASSERT (SELECT COUNT(*)=2 FROM public.solidgate_subscription_history WHERE order_id=v_order), 'cancellation and restoration history both retained';
  -- Full capture followed by partial refund can bootstrap missing fulfillment.
  v_order:='81000000-0000-4000-8000-000000000204';
  PERFORM public.apply_solidgate_financial_event('production','partially-refunded-first-grant',
    '81000000-0000-4000-8000-000000000101:trial1:1',
    jsonb_build_object('order_db_id',v_order,'currency','usd','captured_amount_cents',500,
      'refunded_amount_cents',100,'payment_status','refunded','subscription_id','sub-finance-main'));
  DELETE FROM public.entitlements WHERE order_id=v_order;
  ASSERT public.grant_solidgate_main_entitlement('production',v_order,v_user,'BRAND_000000_SUB','sub-finance-main',500,v_expiry), 'full capture with positive remaining paid money can fulfill';
  v_order:='81000000-0000-4000-8000-000000000202';
  UPDATE public.orders SET status='pending',solidgate_payment_status='creating' WHERE id=v_order;
  UPDATE public.orders SET solidgate_payment_status='partial_settled' WHERE id=v_order;
  ASSERT NOT EXISTS(SELECT 1 FROM public.solidgate_payment_balances WHERE environment='sandbox' AND solidgate_order_id='u-81000000-0000-4000-8000-000000000001:oto2_addon_weekly:1'), 'passive pending partial status cannot infer full quote capture';
  UPDATE public.orders SET status='active',solidgate_payment_status='settle_ok' WHERE id=v_order;
  ASSERT EXISTS(SELECT 1 FROM public.solidgate_analytics_outbox
    WHERE environment='sandbox' AND event_key='order:u-81000000-0000-4000-8000-000000000001:oto2_addon_weekly:1:settled'
      AND (properties->>'revenue')::INTEGER=100), 'browser capture and paid outbox commit atomically';
  RAISE NOTICE 'FINANCIAL RESTORE AND LIFECYCLE PASSED';
END;
$$;

RESET ROLE;
DO $$
BEGIN
  ASSERT NOT has_table_privilege('anon','public.solidgate_financial_movements','SELECT'), 'anonymous ledger access revoked';
  ASSERT NOT has_table_privilege('authenticated','public.solidgate_payment_balances','SELECT'), 'customer cannot read merchant balances';
  ASSERT NOT has_table_privilege('service_role','public.solidgate_financial_movements','UPDATE'), 'history update denied';
  ASSERT NOT has_function_privilege('anon','public.apply_solidgate_financial_event(text,text,text,jsonb,jsonb)','EXECUTE'), 'anonymous financial mutation denied';
  ASSERT NOT has_function_privilege('authenticated','public.restore_solidgate_subscription_entitlement(text,uuid,uuid,text,text,text,timestamptz,text,timestamptz)','EXECUTE'), 'customer cannot restore subscriptions';
  BEGIN
    UPDATE public.solidgate_financial_movements SET net_delta_cents=999;
    RAISE EXCEPTION 'immutable history update should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'FINANCIAL SECURITY PASSED';
END;
$$;
ROLLBACK;
