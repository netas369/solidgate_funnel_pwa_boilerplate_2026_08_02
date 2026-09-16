\set ON_ERROR_STOP on
-- Real aggregation behavior: >1000 rows, native currencies, dated reversals,
-- immutable conversion cohorts, environment isolation, and service-only access.
\connect - supabase_admin
BEGIN;
INSERT INTO auth.users(id,email) VALUES('82000000-0000-4000-8000-000000000001','report@example.test');
INSERT INTO public.sessions(id,user_id,email,locale)
VALUES('82000000-0000-4000-8000-000000000101','82000000-0000-4000-8000-000000000001','report@example.test','en');
INSERT INTO public.orders(id,psp,payment_environment,session_id,user_id,solidgate_order_id,
 product_name,product_slug,status,amount_cents,currency,solidgate_original_amount_cents,
 solidgate_payment_status,solidgate_subscription_id,tracking_metadata,solidgate_customer_email,
 solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,solidgate_checkout_identity_bound_at,created_at)
SELECT ('82000000-0000-4000-8000-' || LPAD((200+n)::TEXT,12,'0'))::UUID,
 'solidgate','sandbox','82000000-0000-4000-8000-000000000101',
 '82000000-0000-4000-8000-000000000001',
 '82000000-0000-4000-8000-000000000101:trial1:'||n,
 'BRAND_000000_SUB','BRAND_000000_SUB','active',500,'eur',500,
 'settle_ok','report-sub-'||n,
 '{"funnel_code":"BRAND","funnel_variant":"main","session_id":"82000000-0000-4000-8000-000000000101","product_slug":"trial1","price_id":"price-report"}'::JSONB,
 'report@example.test','en','price-report','auth_settle','2026-05-01','2026-05-01'
FROM generate_series(1,4) n;
SET LOCAL ROLE service_role;
DO $$
DECLARE r JSONB; o UUID; provider TEXT; n INT;
BEGIN
  FOR n IN 1..4 LOOP
    o:=('82000000-0000-4000-8000-' || LPAD((200+n)::TEXT,12,'0'))::UUID;
    provider:='82000000-0000-4000-8000-000000000101:trial1:'||n;
    PERFORM public.apply_solidgate_financial_event('sandbox','initial-'||n,provider,
      jsonb_build_object('order_db_id',o,'currency','eur','captured_amount_cents',500,
        'payment_status','settle_ok','occurred_at','2026-05-01T01:00:00Z','occurred_at_source','provider_operation'));
    PERFORM public.record_solidgate_subscription_snapshot('sandbox','start-'||n,o,'report-sub-'||n,'create','2026-05-01T01:00:00Z',
      '{"status":"active","started_at":"2026-05-01T01:00:00Z","trial":true,"trial_started_at":"2026-05-01T01:00:00Z"}');
    IF n<4 THEN
      PERFORM public.apply_solidgate_financial_event('sandbox','renew-'||n,'report-renew-'||n,
        jsonb_build_object('order_db_id',o,'currency','eur','captured_amount_cents',1000,'payment_status','settle_ok',
          'invoice_id','report-invoice-'||n,'subscription_id','report-sub-'||n,'subscription_term_number',1,
          'occurred_at',CASE WHEN n=3 THEN '2026-05-12T00:00:00Z' ELSE '2026-05-04T00:00:00Z' END,
          'occurred_at_source','provider_operation'));
    END IF;
  END LOOP;
  -- The refund belongs to May 6, not May 4; a canceled/refunded subscriber
  -- remains a conversion. Trials need not last exactly seven days.
  PERFORM public.apply_solidgate_financial_event('sandbox','refund-1','report-renew-1',
    '{"order_db_id":"82000000-0000-4000-8000-000000000201","currency":"eur","invoice_id":"report-invoice-1","subscription_id":"report-sub-1","refunded_amount_cents":1000,"occurred_at":"2026-05-06T00:00:00Z","occurred_at_source":"provider_operation"}');
  UPDATE public.orders SET status='canceled',updated_at='2026-06-01'
    WHERE id IN ('82000000-0000-4000-8000-000000000201','82000000-0000-4000-8000-000000000202');
  r:=public.get_solidgate_subscription_report('sandbox','2026-05-01','2026-05-08','BRAND_000000_SUB','BRANDADDON_000000_SUB');
  ASSERT (r->>'cohort_size')::INT=4 AND (r->>'converted')::INT=2,
    'cohort must include later canceled/refunded conversions, exclude future renewal and ignore arbitrary7d gate';
  ASSERT (r->>'rolling_numerator')::INT=2 AND (r->>'rolling_denominator')::INT=4,'rolling must use first payment, not mutable updated_at';
  r:=public.get_solidgate_revenue_report('sandbox','2026-05-04','2026-05-05');
  ASSERT (SELECT SUM((v->>'captured_cents')::INT)=2000 FROM jsonb_array_elements(r->'rows') v),'renewals must be in captured gross';
  r:=public.get_solidgate_revenue_report('sandbox','2026-05-06','2026-05-07');
  ASSERT (SELECT SUM((v->>'net_cents')::INT)=-1000 FROM jsonb_array_elements(r->'rows') v),'refund must remain on refund date';
END;
$$;
-- Seed 1101 distinct persisted movements in one day to exceed the Data API cap.
INSERT INTO public.solidgate_financial_movements(environment,event_key,solidgate_order_id,order_id,
 occurred_at,occurred_at_source,currency,captured_delta_cents,refunded_delta_cents,chargeback_delta_cents,net_delta_cents,
 resulting_captured_amount_cents,resulting_refunded_amount_cents,resulting_chargeback_amount_cents,resulting_net_amount_cents,facts)
SELECT 'sandbox','bulk-'||n,'bulk-payment-'||n,'82000000-0000-4000-8000-000000000201',
 '2026-05-15T00:00:00Z','provider_operation',CASE WHEN n%2=0 THEN 'usd' ELSE 'eur' END,
 100,0,0,100,100,0,0,100,'{}' FROM generate_series(1,1101) n;
DO $$
DECLARE r JSONB;
BEGIN
 r:=public.get_solidgate_revenue_report('sandbox','2026-05-15','2026-05-16');
 ASSERT (SELECT SUM((v->>'captured_cents')::INT)=110100 AND SUM((v->>'payments')::INT)=1101 FROM jsonb_array_elements(r->'rows') v),
   'all1101payments must be aggregated, never truncated at1000';
 ASSERT jsonb_array_length(r->'rows')=2,'native currencies must remain separate';
 r:=public.get_solidgate_revenue_report('production','2026-05-15','2026-05-16');
 ASSERT jsonb_array_length(r->'rows')=0,'sandbox cannot enter production report';
 ASSERT NOT has_function_privilege('anon','public.get_solidgate_revenue_report(text,timestamptz,timestamptz)','execute');
 ASSERT NOT has_function_privilege('authenticated','public.get_solidgate_subscription_report(text,timestamptz,timestamptz,text,text)','execute');
 BEGIN
  PERFORM public.get_solidgate_revenue_report('sandbox','2026-05-16','2026-05-15');
  RAISE EXCEPTION 'invalid range unexpectedly accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END;
$$;
ROLLBACK;
\echo 'solidgate_financial_reporting PASSED'
