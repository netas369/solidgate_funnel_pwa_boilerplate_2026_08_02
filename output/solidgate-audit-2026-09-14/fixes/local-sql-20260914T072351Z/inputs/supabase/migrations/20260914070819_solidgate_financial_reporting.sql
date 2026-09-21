-- Aggregation happens inside PostgreSQL; no PostgREST row cap can truncate money.
CREATE OR REPLACE FUNCTION public.get_solidgate_revenue_report(
  p_environment TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result JSONB;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('production','sandbox')
    OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to THEN
    RAISE EXCEPTION 'invalid report range or environment' USING ERRCODE='22023';
  END IF;
  WITH movements AS (
    SELECT m.*, o.product_slug,
      CASE WHEN m.solidgate_order_id=o.solidgate_order_id THEN 'initial' ELSE 'renewal' END AS billing_type
    FROM public.solidgate_financial_movements m JOIN public.orders o ON o.id=m.order_id
    WHERE m.environment=p_environment AND m.occurred_at>=p_from AND m.occurred_at<p_to
  ), grouped AS (
    SELECT (occurred_at AT TIME ZONE 'UTC')::DATE::TEXT AS day,currency,billing_type,product_slug,
      SUM(captured_delta_cents) AS captured_cents,SUM(refunded_delta_cents) AS refunded_cents,
      SUM(chargeback_delta_cents) AS chargeback_cents,SUM(net_delta_cents) AS net_cents,
      COUNT(DISTINCT solidgate_order_id) FILTER(WHERE captured_delta_cents>0) AS payments
    FROM movements GROUP BY 1,2,3,4
  ) SELECT jsonb_build_object(
      'rows',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY day,currency,billing_type,product_slug) FROM grouped g),'[]'::JSONB),
      'legacy_movements',(SELECT COUNT(*) FROM movements WHERE evidence_source='legacy_projection'),
      'estimated_timing_movements',(SELECT COUNT(*) FROM movements WHERE occurred_at_source<>'provider_operation')
    ) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_solidgate_revenue_report(TEXT,TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_revenue_report(TEXT,TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;

-- Cohorts depend on immutable starts and first captured renewal, never current
-- access status or orders.updated_at. A later refund/cancellation cannot erase
-- the historical fact that the subscriber converted. Conversion is as of p_to.
CREATE OR REPLACE FUNCTION public.get_solidgate_subscription_report(
  p_environment TEXT,p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_main_product TEXT,p_addon_product TEXT
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result JSONB;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('production','sandbox')
    OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to THEN
    RAISE EXCEPTION 'invalid report range or environment' USING ERRCODE='22023';
  END IF;
  WITH starts AS (
    SELECT o.id,o.status,o.solidgate_order_id,
      COALESCE(s.trial_started_at,s.started_at,b.first_captured_at,o.created_at) AS started_at,
      (s.trial_started_at IS NULL AND s.started_at IS NULL AND b.first_captured_at IS NULL) AS legacy_start,
      (SELECT MIN(r.first_captured_at) FROM public.solidgate_payment_balances r
       WHERE r.environment=p_environment AND r.order_id=o.id AND r.solidgate_order_id<>o.solidgate_order_id
         AND r.subscription_term_number>0 AND r.captured_amount_cents>0) AS first_paid_at
    FROM public.orders o
    LEFT JOIN public.solidgate_subscription_snapshots s ON s.environment=p_environment AND s.order_id=o.id
    LEFT JOIN public.solidgate_payment_balances b ON b.environment=p_environment AND b.solidgate_order_id=o.solidgate_order_id
    WHERE o.payment_environment=p_environment AND o.psp='solidgate' AND o.product_slug=p_main_product
      AND o.solidgate_subscription_id IS NOT NULL
      AND (s.started_at IS NOT NULL OR b.first_captured_at IS NOT NULL OR o.status NOT IN ('pending','failed'))
  ), cohort AS (SELECT * FROM starts WHERE started_at>=p_from AND started_at<p_to),
  active_addon AS (
    SELECT e.user_id,e.expires_at,e.product_slug,e.order_id
    FROM public.entitlements e
    WHERE e.payment_environment=p_environment AND e.product_slug IN (p_addon_product,'oto2_addon_weekly')
      AND e.status='active' AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>NOW())
  ), addon_pricing AS (
    SELECT e.*,price.currency,price.monthly_cents FROM active_addon e
    LEFT JOIN LATERAL (
      SELECT b.currency,ROUND(b.captured_amount_cents * (365.2425/12) /
        (EXTRACT(EPOCH FROM (b.period_end_at-b.period_start_at))/86400.0))::BIGINT AS monthly_cents
      FROM public.solidgate_payment_balances b
      WHERE b.environment=p_environment AND b.order_id=e.order_id AND b.subscription_term_number>0
        AND b.captured_amount_cents>0 AND b.period_end_at>b.period_start_at AND NOT b.needs_reconciliation
      ORDER BY b.period_start_at DESC NULLS LAST,b.first_captured_at DESC LIMIT 1
    ) price ON TRUE
  ) SELECT jsonb_build_object(
    'cohort_size',(SELECT COUNT(*) FROM cohort),
    'converted',(SELECT COUNT(*) FROM cohort WHERE first_paid_at<p_to),
    'rolling_numerator',(SELECT COUNT(*) FROM starts WHERE first_paid_at>=p_from AND first_paid_at<p_to),
    'rolling_denominator',(SELECT COUNT(*) FROM starts WHERE started_at<p_to AND (first_paid_at IS NULL OR first_paid_at>=p_from)),
    'legacy_starts',(SELECT COUNT(*) FROM cohort WHERE legacy_start),
    'status',jsonb_build_object(
      'trialing',(SELECT COUNT(*) FROM cohort WHERE status='trialing'),
      'active',(SELECT COUNT(*) FROM cohort WHERE status='active'),
      'pastDue',(SELECT COUNT(*) FROM cohort WHERE status='past_due'),
      'canceled',(SELECT COUNT(*) FROM cohort WHERE status='canceled'),
      'other',(SELECT COUNT(*) FROM cohort WHERE status NOT IN ('trialing','active','past_due','canceled')),
      'total',(SELECT COUNT(*) FROM cohort)),
    'variants',jsonb_build_object(
      'main',(SELECT COUNT(*) FROM cohort WHERE solidgate_order_id ~ ':trial[1-4]:[0-9]+$'),
      'special1eur',(SELECT COUNT(*) FROM cohort WHERE solidgate_order_id ~ ':special_1eur:[0-9]+$'),
      'specialFree',(SELECT COUNT(*) FROM cohort WHERE solidgate_order_id ~ ':special_free:[0-9]+$'),
      'legacy',(SELECT COUNT(*) FROM cohort WHERE solidgate_order_id IS NULL OR solidgate_order_id !~ ':(trial[1-4]|special_1eur|special_free):[0-9]+$'),
      'total',(SELECT COUNT(*) FROM cohort)),
    'addon',jsonb_build_object(
      'active_count',(SELECT COUNT(*) FROM active_addon),
      'unknown_price_count',(SELECT COUNT(*) FROM addon_pricing WHERE monthly_cents IS NULL),
      'monthly_amounts',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM (
        SELECT currency,SUM(monthly_cents) AS amount_cents FROM addon_pricing WHERE monthly_cents IS NOT NULL GROUP BY currency
      ) g),'[]'::JSONB),
      'sample',COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM (
        SELECT user_id,expires_at,product_slug FROM active_addon ORDER BY user_id LIMIT 5
      ) g),'[]'::JSONB))
  ) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_solidgate_subscription_report(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_subscription_report(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.get_solidgate_purchase_counts(
  p_environment TEXT,p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_products TEXT[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_result JSONB;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('production','sandbox')
    OR p_from IS NULL OR p_to IS NULL OR p_from>=p_to THEN
    RAISE EXCEPTION 'invalid report range or environment' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(g)),'[]'::JSONB) INTO v_result FROM (
    SELECT o.product_slug,COUNT(*) AS count FROM public.orders o
    LEFT JOIN public.solidgate_payment_balances b ON b.environment=p_environment AND b.solidgate_order_id=o.solidgate_order_id
    LEFT JOIN public.solidgate_subscription_snapshots s ON s.environment=p_environment AND s.order_id=o.id
    WHERE o.psp='solidgate' AND o.payment_environment=p_environment AND o.product_slug=ANY(p_products)
      AND COALESCE(b.first_captured_at,s.started_at)>=p_from AND COALESCE(b.first_captured_at,s.started_at)<p_to
    GROUP BY o.product_slug
  ) g;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_solidgate_purchase_counts(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_solidgate_purchase_counts(TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT[]) TO service_role;
