\set ON_ERROR_STOP on
DO $$
DECLARE v_report JSONB; v_snapshot JSONB;
BEGIN
  ASSERT (SELECT COUNT(*)=8 FROM public.solidgate_payment_balances), 'one balance per legacy payment';
  ASSERT (SELECT COUNT(*)=8 FROM public.solidgate_financial_movements), 'one opening movement per legacy payment';
  ASSERT NOT EXISTS (
    SELECT 1 FROM audit_verification.expected_balances e
    LEFT JOIN public.solidgate_payment_balances b USING(environment,solidgate_order_id)
    WHERE b.solidgate_order_id IS NULL OR b.order_id<>e.order_id OR b.user_id<>e.user_id
      OR b.solidgate_invoice_id IS DISTINCT FROM e.invoice_id
      OR b.captured_amount_cents<>e.captured OR b.refunded_amount_cents<>e.refunded
      OR b.chargeback_amount_cents<>e.chargeback OR b.net_amount_cents<>e.net
      OR b.first_captured_at IS DISTINCT FROM e.observed_at OR b.currency<>'usd'
      OR b.capture_evidence_source<>'legacy_projection'
      OR b.first_captured_at_source<>'legacy_observation' OR NOT b.needs_reconciliation
  ), 'all amounts, ownership, invoice binding and estimated provenance preserved';
  ASSERT NOT EXISTS (
    SELECT 1 FROM audit_verification.expected_balances e
    LEFT JOIN public.solidgate_financial_movements m USING(environment,solidgate_order_id)
    WHERE m.solidgate_order_id IS NULL OR m.order_id<>e.order_id OR m.user_id<>e.user_id
      OR m.solidgate_invoice_id IS DISTINCT FROM e.invoice_id
      OR m.event_key<>'legacy-opening-balance' OR m.evidence_source<>'legacy_projection'
      OR m.occurred_at_source<>'legacy_observation' OR m.occurred_at IS DISTINCT FROM e.observed_at
      OR m.captured_delta_cents<>e.captured OR m.refunded_delta_cents<>e.refunded
      OR m.chargeback_delta_cents<>e.chargeback OR m.net_delta_cents<>e.net
      OR m.resulting_captured_amount_cents<>e.captured OR m.resulting_refunded_amount_cents<>e.refunded
      OR m.resulting_chargeback_amount_cents<>e.chargeback OR m.resulting_net_amount_cents<>e.net
      OR m.facts->>'notice' NOT LIKE 'Estimated legacy projection.%'
  ), 'opening movements conserve each payment and clearly mark estimated data';
  ASSERT (SELECT SUM(captured_delta_cents)=25600 AND SUM(refunded_delta_cents)=7800
    AND SUM(chargeback_delta_cents)=6400 AND SUM(net_delta_cents)=11400
    FROM public.solidgate_financial_movements), 'cash totals are conserved';
  ASSERT (SELECT COUNT(*)=8 AND BOOL_AND(issue='legacy_amount_requires_provider_reconciliation')
    FROM public.solidgate_reconciliation_issues), 'all historical estimates require provider reconciliation';
  ASSERT NOT EXISTS (
    SELECT 1 FROM audit_verification.legacy_rows e
    LEFT JOIN (SELECT 'orders' AS source,id,to_jsonb(o) AS row FROM public.orders o
      UNION ALL SELECT 'renewal_events',id,to_jsonb(r) FROM public.renewal_events r) current
      USING(source,id)
    WHERE current.row IS DISTINCT FROM e.row
  ), 'migration does not rewrite original order or renewal projections';
  v_report:=public.get_solidgate_revenue_report('sandbox','2026-08-01','2026-10-01');
  ASSERT v_report->>'legacy_movements'='8' AND v_report->>'estimated_timing_movements'='8',
    'report exposes legacy amount and timing provenance';
  ASSERT (SELECT SUM((r->>'captured_cents')::BIGINT)=25600
    AND SUM((r->>'refunded_cents')::BIGINT)=7800
    AND SUM((r->>'chargeback_cents')::BIGINT)=6400
    AND SUM((r->>'net_cents')::BIGINT)=11400
    AND SUM((r->>'payments')::BIGINT)=8
    FROM jsonb_array_elements(v_report->'rows') r), 'report conserves opening balance amounts';
  ASSERT (SELECT SUM((r->>'net_cents')::BIGINT)=800 AND SUM((r->>'payments')::BIGINT)=4
    FROM jsonb_array_elements(v_report->'rows') r WHERE r->>'billing_type'='initial'),
    'initial classification preserved';
  ASSERT (SELECT SUM((r->>'net_cents')::BIGINT)=10600 AND SUM((r->>'payments')::BIGINT)=4
    FROM jsonb_array_elements(v_report->'rows') r WHERE r->>'billing_type'='renewal'),
    'renewal classification preserved';
  ASSERT public.get_solidgate_revenue_report('production','2026-08-01','2026-10-01')->'rows'='[]'::JSONB,
    'environment remains isolated';
  v_snapshot:=jsonb_build_object('balances',
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY environment,solidgate_order_id) FROM public.solidgate_payment_balances b),
    'movements',(SELECT jsonb_agg(to_jsonb(m) ORDER BY environment,solidgate_order_id) FROM public.solidgate_financial_movements m),
    'report',v_report);
  IF to_regclass('audit_verification.first_migration_snapshot') IS NULL THEN
    CREATE TABLE audit_verification.first_migration_snapshot(snapshot JSONB);
    INSERT INTO audit_verification.first_migration_snapshot VALUES(v_snapshot);
  ELSE
    ASSERT (SELECT snapshot=v_snapshot FROM audit_verification.first_migration_snapshot),
      'reapplying both migrations must preserve complete balances, movements and report byte-for-byte';
  END IF;
  RAISE NOTICE 'LEGACY POPULATED UPGRADE PASSED: 8 payments, captured 25600, refunded 7800, chargeback 6400, net 11400 cents; estimated provenance and idempotence verified';
END $$;
SELECT jsonb_pretty(public.get_solidgate_revenue_report('sandbox','2026-08-01','2026-10-01'));
