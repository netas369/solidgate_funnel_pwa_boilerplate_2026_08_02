-- Reusable admin-core security primitives. Additive so projects that already
-- applied 00002_admin_support.sql can upgrade without rewriting history.

ALTER TABLE public.support_action_audit
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_action_audit_idempotency
  ON public.support_action_audit (actor_user_id, action, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.admin_rate_limit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope ~ '^[a-z0-9_:-]{1,64}$'),
  subject_digest TEXT NOT NULL CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_rate_limit_scope_subject_time
  ON public.admin_rate_limit_events (scope, subject_digest, occurred_at DESC);

ALTER TABLE public.admin_rate_limit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_rate_limit_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_rate_limit_events TO service_role;

CREATE OR REPLACE FUNCTION public.consume_admin_rate_limit(
  p_scope TEXT,
  p_subject_digest TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  event_count INTEGER;
BEGIN
  IF p_scope !~ '^[a-z0-9_:-]{1,64}$'
    OR p_subject_digest !~ '^[0-9a-f]{64}$'
    OR p_limit < 1
    OR p_window_seconds < 1
  THEN
    RAISE EXCEPTION 'invalid admin rate-limit input' USING ERRCODE = '22023';
  END IF;

  -- Serialize one actor/scope bucket so parallel requests cannot all pass the
  -- count before any inserts become visible.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_scope || ':' || p_subject_digest, 0));

  -- Keep frequently used subjects bounded without making every admin request
  -- contend on a global cleanup. Operations may additionally prune abandoned
  -- subjects according to its retention policy.
  DELETE FROM public.admin_rate_limit_events
  WHERE scope = p_scope
    AND subject_digest = p_subject_digest
    AND occurred_at < now() - make_interval(secs => GREATEST(p_window_seconds, 86400));

  SELECT COUNT(*)::INTEGER
  INTO event_count
  FROM public.admin_rate_limit_events
  WHERE scope = p_scope
    AND subject_digest = p_subject_digest
    AND occurred_at >= now() - make_interval(secs => p_window_seconds);

  IF event_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.admin_rate_limit_events (scope, subject_digest)
  VALUES (p_scope, p_subject_digest);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_admin_rate_limit(TEXT, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_admin_rate_limit(TEXT, TEXT, INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.consume_admin_rate_limit(TEXT, TEXT, INTEGER, INTEGER) IS
  'Atomically consumes one PII-free admin request-rate bucket entry.';

CREATE INDEX IF NOT EXISTS idx_admin_trial_cohort_range
  ON public.orders (payment_environment, product_slug, created_at)
  WHERE solidgate_subscription_id IS NOT NULL
    AND status NOT IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_admin_renewal_attempt_range
  ON public.solidgate_invoice_orders (
    environment,
    (COALESCE(source_created_at, created_at))
  )
  WHERE subscription_term_number > 0;

CREATE INDEX IF NOT EXISTS idx_admin_renewal_subscription
  ON public.renewal_events (
    payment_environment,
    solidgate_subscription_id,
    created_at
  );

-- V2 makes cohort maturity and environment explicit and separates first-card
-- success from eventual recovery. The original function remains available for
-- projects upgrading while application code moves to this contract.
CREATE OR REPLACE FUNCTION public.admin_subscription_performance_by_locale_v2(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_main_product_slugs TEXT[],
  p_payment_environment TEXT,
  p_trial_maturity_days INTEGER
)
RETURNS TABLE (
  locale TEXT,
  trial_starts BIGINT,
  trial_conversions BIGINT,
  renewal_invoices BIGINT,
  first_attempt_successful_renewals BIGINT,
  successful_renewals BIGINT,
  recovered_renewals BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH trial_cohort AS (
    SELECT DISTINCT ON (o.solidgate_subscription_id)
      o.solidgate_subscription_id,
      o.created_at AS trial_started_at,
      COALESCE(
        NULLIF(BTRIM(o.solidgate_checkout_locale), ''),
        NULLIF(BTRIM(s.locale), ''),
        'unknown'
      ) AS locale
    FROM public.orders AS o
    LEFT JOIN public.sessions AS s ON s.id = o.session_id
    WHERE p_from < p_to
      AND p_trial_maturity_days >= 0
      AND o.payment_environment = p_payment_environment
      AND o.product_slug = ANY(p_main_product_slugs)
      AND o.solidgate_subscription_id IS NOT NULL
      AND o.status NOT IN ('pending', 'failed')
      AND o.created_at >= p_from
      AND o.created_at < LEAST(
        p_to,
        now() - make_interval(days => p_trial_maturity_days)
      )
    ORDER BY o.solidgate_subscription_id, o.created_at, o.id
  ),
  trial_with_first_paid AS (
    SELECT
      tc.locale,
      tc.trial_started_at,
      (
        SELECT MIN(r.created_at)
        FROM public.renewal_events AS r
        WHERE r.payment_environment = p_payment_environment
          AND r.solidgate_subscription_id = tc.solidgate_subscription_id
      ) AS first_paid_at
    FROM trial_cohort AS tc
  ),
  trial_metrics AS (
    SELECT
      locale,
      COUNT(*)::BIGINT AS trial_starts,
      COUNT(*) FILTER (
        WHERE first_paid_at >= trial_started_at + make_interval(days => p_trial_maturity_days)
      )::BIGINT AS trial_conversions
    FROM trial_with_first_paid
    GROUP BY locale
  ),
  ranked_attempts AS (
    SELECT
      io.solidgate_subscription_id,
      io.solidgate_invoice_id,
      io.status,
      COALESCE(io.source_created_at, io.created_at) AS attempted_at,
      ROW_NUMBER() OVER (
        PARTITION BY io.solidgate_subscription_id, io.solidgate_invoice_id
        ORDER BY COALESCE(io.source_created_at, io.created_at), io.solidgate_order_id
      ) AS attempt_number
    FROM public.solidgate_invoice_orders AS io
    WHERE io.environment = p_payment_environment
      AND io.subscription_term_number > 0
  ),
  invoice_rollup AS (
    SELECT
      solidgate_subscription_id,
      solidgate_invoice_id,
      MIN(attempted_at) AS first_attempt_at,
      BOOL_OR(
        attempt_number = 1
        AND status IN ('settle_ok', 'approved', 'partial_settled', 'success')
      ) AS first_attempt_succeeded
    FROM ranked_attempts
    GROUP BY solidgate_subscription_id, solidgate_invoice_id
  ),
  renewal_cohort AS (
    SELECT
      ir.solidgate_invoice_id,
      COALESCE(NULLIF(BTRIM(origin.locale), ''), 'unknown') AS locale,
      ir.first_attempt_succeeded,
      EXISTS (
        SELECT 1
        FROM public.renewal_events AS r
        WHERE r.payment_environment = p_payment_environment
          AND r.solidgate_subscription_id = ir.solidgate_subscription_id
          AND r.solidgate_invoice_id = ir.solidgate_invoice_id
      ) AS eventually_succeeded
    FROM invoice_rollup AS ir
    LEFT JOIN LATERAL (
      SELECT COALESCE(o.solidgate_checkout_locale, s.locale) AS locale
      FROM public.orders AS o
      LEFT JOIN public.sessions AS s ON s.id = o.session_id
      WHERE o.payment_environment = p_payment_environment
        AND o.solidgate_subscription_id = ir.solidgate_subscription_id
      ORDER BY o.created_at
      LIMIT 1
    ) AS origin ON TRUE
    WHERE p_from < p_to
      AND ir.first_attempt_at >= p_from
      AND ir.first_attempt_at < p_to
  ),
  renewal_metrics AS (
    SELECT
      locale,
      COUNT(*)::BIGINT AS renewal_invoices,
      COUNT(*) FILTER (WHERE first_attempt_succeeded)::BIGINT
        AS first_attempt_successful_renewals,
      COUNT(*) FILTER (WHERE eventually_succeeded)::BIGINT AS successful_renewals,
      COUNT(*) FILTER (
        WHERE eventually_succeeded AND NOT first_attempt_succeeded
      )::BIGINT AS recovered_renewals
    FROM renewal_cohort
    GROUP BY locale
  ),
  locales AS (
    SELECT locale FROM trial_metrics
    UNION
    SELECT locale FROM renewal_metrics
  )
  SELECT
    locales.locale,
    COALESCE(tm.trial_starts, 0)::BIGINT,
    COALESCE(tm.trial_conversions, 0)::BIGINT,
    COALESCE(rm.renewal_invoices, 0)::BIGINT,
    COALESCE(rm.first_attempt_successful_renewals, 0)::BIGINT,
    COALESCE(rm.successful_renewals, 0)::BIGINT,
    COALESCE(rm.recovered_renewals, 0)::BIGINT
  FROM locales
  LEFT JOIN trial_metrics AS tm USING (locale)
  LEFT JOIN renewal_metrics AS rm USING (locale)
  ORDER BY (locales.locale = 'unknown'), locales.locale;
$$;

REVOKE ALL ON FUNCTION public.admin_subscription_performance_by_locale_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscription_performance_by_locale_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.admin_subscription_performance_by_locale_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, INTEGER
) IS
  'Mature trial conversion plus first-attempt, recovered, and eventual renewal success by locale and payment environment.';

CREATE OR REPLACE FUNCTION public.admin_customer_ltv_by_currency_v2(
  p_payment_environment TEXT
)
RETURNS TABLE (
  currency TEXT,
  net_amount_cents BIGINT,
  customer_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH order_identities AS (
    SELECT
      o.solidgate_subscription_id,
      COALESCE(
        NULLIF(LOWER(BTRIM(o.solidgate_customer_email)), ''),
        NULLIF(LOWER(BTRIM(s.email)), ''),
        CASE WHEN o.user_id IS NOT NULL THEN 'user:' || o.user_id::TEXT END,
        CASE WHEN o.session_id IS NOT NULL THEN 'session:' || o.session_id::TEXT END
      ) AS customer_key,
      o.created_at,
      LOWER(o.currency) AS currency,
      o.amount_cents::BIGINT AS net_amount_cents,
      o.status,
      COALESCE(o.solidgate_original_amount_cents, o.amount_cents) AS gross_amount_cents
    FROM public.orders AS o
    LEFT JOIN public.sessions AS s ON s.id = o.session_id
    WHERE o.payment_environment = p_payment_environment
  ),
  subscription_identities AS (
    -- One customer identity per subscription prevents a second order tied to
    -- that subscription (for example an add-on) from multiplying renewals.
    SELECT DISTINCT ON (solidgate_subscription_id)
      solidgate_subscription_id,
      customer_key
    FROM order_identities
    WHERE solidgate_subscription_id IS NOT NULL
      AND customer_key IS NOT NULL
    ORDER BY solidgate_subscription_id, created_at
  ),
  customer_revenue AS (
    SELECT customer_key, currency, net_amount_cents
    FROM order_identities
    WHERE customer_key IS NOT NULL
      AND status NOT IN ('pending', 'failed')
      AND gross_amount_cents > 0

    UNION ALL

    SELECT si.customer_key, LOWER(r.currency), r.amount_cents::BIGINT
    FROM public.renewal_events AS r
    JOIN subscription_identities AS si
      ON si.solidgate_subscription_id = r.solidgate_subscription_id
    WHERE r.payment_environment = p_payment_environment
  ),
  population AS (
    SELECT COUNT(DISTINCT customer_key)::BIGINT AS customer_count
    FROM customer_revenue
  )
  SELECT
    cr.currency,
    SUM(cr.net_amount_cents)::BIGINT,
    p.customer_count
  FROM customer_revenue AS cr
  CROSS JOIN population AS p
  GROUP BY cr.currency, p.customer_count
  ORDER BY cr.currency;
$$;

REVOKE ALL ON FUNCTION public.admin_customer_ltv_by_currency_v2(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customer_ltv_by_currency_v2(TEXT)
  TO service_role;

COMMENT ON FUNCTION public.admin_customer_ltv_by_currency_v2(TEXT) IS
  'All-time net captured order and renewal revenue by currency with the distinct paying-customer population for one payment environment.';
