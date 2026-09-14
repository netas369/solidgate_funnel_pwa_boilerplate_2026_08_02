\set ON_ERROR_STOP on
CREATE SCHEMA audit_verification;

INSERT INTO auth.users(id,email)
SELECT ('82000000-0000-4000-8000-'||LPAD(i::TEXT,12,'0'))::UUID,
  'legacy-'||i||'@example.test'
FROM generate_series(1,4) AS fixture(i);
INSERT INTO public.sessions(id,user_id,email,locale)
SELECT ('82000000-0000-4000-8000-'||LPAD((100+i)::TEXT,12,'0'))::UUID,
  ('82000000-0000-4000-8000-'||LPAD(i::TEXT,12,'0'))::UUID,
  'legacy-'||i||'@example.test','en'
FROM generate_series(1,4) AS fixture(i);

INSERT INTO public.orders (
  id,psp,payment_environment,session_id,user_id,solidgate_order_id,
  product_name,product_slug,status,amount_cents,currency,
  solidgate_original_amount_cents,solidgate_payment_status,
  solidgate_refunded_amount_cents,solidgate_chargeback_id,
  solidgate_chargeback_status,solidgate_chargeback_amount_cents,
  solidgate_subscription_id,tracking_metadata,solidgate_customer_email,
  solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,
  solidgate_checkout_identity_bound_at,created_at
)
SELECT ('82000000-0000-4000-8000-'||LPAD((200+i)::TEXT,12,'0'))::UUID,
  'solidgate','sandbox',session_id,user_id,session_id::TEXT||':trial1:1',
  'BRAND_000000_SUB','BRAND_000000_SUB',status,500,'usd',500,payment,
  refund,CASE WHEN cb>0 THEN 'cb-legacy-initial' END,
  CASE WHEN cb>0 THEN 'in_progress' END,cb,'sub-legacy-'||i,
  jsonb_build_object('funnel_code','BRAND','funnel_variant','main',
    'session_id',session_id::TEXT,'product_slug','trial1','price_id','price-legacy-main'),
  'legacy-'||i||'@example.test','en','price-legacy-main','auth_settle',
  '2026-08-01T12:00:00Z','2026-08-01T12:00:00Z'
FROM (VALUES
  (1,'completed',500,0,0,'settle_ok'),
  (2,'refunded',0,500,0,'refunded'),
  (3,'completed',300,200,0,'refunded'),
  (4,'disputed',0,0,500,'settle_ok')
) AS fixture(i,status,net,refund,cb,payment)
CROSS JOIN LATERAL (SELECT
  ('82000000-0000-4000-8000-'||LPAD((100+i)::TEXT,12,'0'))::UUID AS session_id,
  ('82000000-0000-4000-8000-'||LPAD(i::TEXT,12,'0'))::UUID AS user_id
) AS identity;

-- Legacy writers retain net money in orders after refund/dispute. Insert uses
-- the valid catalog quote, then apply those historical projections with guards active.
UPDATE public.orders SET amount_cents=CASE
  WHEN solidgate_subscription_id='sub-legacy-1' THEN 500
  WHEN solidgate_subscription_id='sub-legacy-3' THEN 300 ELSE 0 END;

INSERT INTO public.renewal_events (
  payment_environment,solidgate_invoice_id,solidgate_subscription_id,
  solidgate_order_id,subscription_term_number,amount_cents,gross_amount_cents,
  refunded_amount_cents,currency,product_key,status,chargeback_id,
  chargeback_status,chargeback_amount_cents,invoice_created_at,event_created_at,created_at
)
SELECT 'sandbox','invoice-legacy-'||i,'sub-legacy-1','renewal-legacy-'||i,i,
  net,5900,refund,'usd','BRAND_000000_SUB',status,
  CASE WHEN cb>0 THEN 'cb-legacy-renewal' END,
  CASE WHEN cb>0 THEN 'in_progress' END,cb,
  '2026-09-01T00:00:00Z'::TIMESTAMPTZ + (i-1)*INTERVAL '1 day',
  '2026-09-01T12:00:00Z'::TIMESTAMPTZ + (i-1)*INTERVAL '1 day',
  '2026-09-01T13:00:00Z'::TIMESTAMPTZ + (i-1)*INTERVAL '1 day'
FROM (VALUES
  (1,'paid',5900,0,0),
  (2,'partially_refunded',4700,1200,0),
  (3,'refunded',0,5900,0),
  (4,'disputed',0,0,5900)
) AS fixture(i,status,net,refund,cb);

CREATE TABLE audit_verification.legacy_rows AS
SELECT 'orders'::TEXT AS source,id,to_jsonb(o) AS row FROM public.orders o
UNION ALL SELECT 'renewal_events',id,to_jsonb(r) FROM public.renewal_events r;
CREATE TABLE audit_verification.expected_balances AS
SELECT payment_environment AS environment,solidgate_order_id,id AS order_id,user_id,
  NULL::TEXT AS invoice_id,solidgate_original_amount_cents AS captured,
  solidgate_refunded_amount_cents AS refunded,solidgate_chargeback_amount_cents AS chargeback,
  amount_cents AS net,created_at AS observed_at
FROM public.orders
UNION ALL
SELECT r.payment_environment,r.solidgate_order_id,o.id,o.user_id,r.solidgate_invoice_id,
  r.gross_amount_cents,r.refunded_amount_cents,r.chargeback_amount_cents,r.amount_cents,
  r.event_created_at
FROM public.renewal_events r JOIN public.orders o
  ON o.payment_environment=r.payment_environment AND o.solidgate_subscription_id=r.solidgate_subscription_id;
DO $$ BEGIN
  ASSERT to_regclass('public.solidgate_payment_balances') IS NULL,
    'legacy fixture must be inserted before financial schema exists';
  ASSERT (SELECT COUNT(*)=8 FROM audit_verification.expected_balances);
  RAISE NOTICE 'LEGACY UPGRADE SEED PASSED: four initials and four renewals, strict checkout identities';
END $$;
