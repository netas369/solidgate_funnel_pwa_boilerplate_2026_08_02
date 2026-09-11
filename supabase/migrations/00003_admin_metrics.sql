-- Project-neutral admin aggregates that should stay inside Postgres instead of
-- downloading the complete payment ledger into the Next.js process.

CREATE OR REPLACE FUNCTION public.admin_customer_ltv_by_currency()
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
      LOWER(o.currency) AS currency,
      o.amount_cents::BIGINT AS net_amount_cents,
      o.status,
      COALESCE(o.solidgate_original_amount_cents, o.amount_cents) AS gross_amount_cents
    FROM public.orders AS o
    LEFT JOIN public.sessions AS s ON s.id = o.session_id
    WHERE o.payment_environment = 'production'
  ),
  customer_revenue AS (
    -- Initial payments and one-time purchases. amount_cents is the durable net
    -- amount after refunds and chargebacks. A fully refunded customer remains
    -- in the population with zero net value because gross_amount_cents proves
    -- that a real payment was captured previously.
    SELECT
      customer_key,
      currency,
      net_amount_cents
    FROM order_identities
    WHERE customer_key IS NOT NULL
      AND status NOT IN ('pending', 'failed')
      AND gross_amount_cents > 0

    UNION ALL

    -- Successful renewals only exist in renewal_events. amount_cents is also
    -- maintained as net after refund/chargeback lifecycle updates.
    SELECT
      oi.customer_key,
      LOWER(r.currency),
      r.amount_cents::BIGINT
    FROM public.renewal_events AS r
    JOIN order_identities AS oi
      ON oi.solidgate_subscription_id = r.solidgate_subscription_id
    WHERE r.payment_environment = 'production'
      AND oi.customer_key IS NOT NULL
  ),
  population AS (
    SELECT COUNT(DISTINCT customer_key)::BIGINT AS customer_count
    FROM customer_revenue
  )
  SELECT
    cr.currency,
    SUM(cr.net_amount_cents)::BIGINT AS net_amount_cents,
    p.customer_count
  FROM customer_revenue AS cr
  CROSS JOIN population AS p
  GROUP BY cr.currency, p.customer_count
  ORDER BY cr.currency;
$$;

REVOKE ALL ON FUNCTION public.admin_customer_ltv_by_currency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_customer_ltv_by_currency() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customer_ltv_by_currency() TO service_role;

COMMENT ON FUNCTION public.admin_customer_ltv_by_currency() IS
  'All-time production net order plus renewal revenue by currency and the distinct paying-customer population used for average realized LTV.';

CREATE OR REPLACE FUNCTION public.admin_subscription_performance_by_locale(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_main_product_slug TEXT
)
RETURNS TABLE (
  locale TEXT,
  trial_starts BIGINT,
  trial_conversions BIGINT,
  renewal_invoices BIGINT,
  successful_renewals BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH trial_cohort AS (
    SELECT
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
      AND o.payment_environment = 'production'
      AND o.product_slug = p_main_product_slug
      AND o.status NOT IN ('pending', 'failed')
      AND o.created_at >= p_from
      AND o.created_at < p_to
  ),
  trial_with_first_paid AS (
    SELECT
      tc.locale,
      tc.trial_started_at,
      (
        SELECT MIN(r.created_at)
        FROM public.renewal_events AS r
        WHERE r.payment_environment = 'production'
          AND r.solidgate_subscription_id = tc.solidgate_subscription_id
      ) AS first_paid_at
    FROM trial_cohort AS tc
  ),
  trial_metrics AS (
    SELECT
      locale,
      COUNT(*)::BIGINT AS trial_starts,
      COUNT(*) FILTER (
        WHERE first_paid_at >= trial_started_at + INTERVAL '7 days'
      )::BIGINT AS trial_conversions
    FROM trial_with_first_paid
    GROUP BY locale
  ),
  invoice_first_attempt AS (
    SELECT
      io.solidgate_subscription_id,
      io.solidgate_invoice_id,
      MIN(io.created_at) AS first_attempt_at
    FROM public.solidgate_invoice_orders AS io
    WHERE io.environment = 'production'
      AND io.subscription_term_number > 0
    GROUP BY io.solidgate_subscription_id, io.solidgate_invoice_id
  ),
  renewal_cohort AS (
    SELECT
      ifa.solidgate_invoice_id,
      COALESCE(
        NULLIF(BTRIM(o.solidgate_checkout_locale), ''),
        NULLIF(BTRIM(s.locale), ''),
        'unknown'
      ) AS locale,
      EXISTS (
        SELECT 1
        FROM public.renewal_events AS r
        WHERE r.payment_environment = 'production'
          AND r.solidgate_invoice_id = ifa.solidgate_invoice_id
      ) AS succeeded
    FROM invoice_first_attempt AS ifa
    LEFT JOIN public.orders AS o
      ON o.payment_environment = 'production'
      AND o.solidgate_subscription_id = ifa.solidgate_subscription_id
    LEFT JOIN public.sessions AS s ON s.id = o.session_id
    WHERE p_from < p_to
      AND ifa.first_attempt_at >= p_from
      AND ifa.first_attempt_at < p_to
  ),
  renewal_metrics AS (
    SELECT
      locale,
      COUNT(*)::BIGINT AS renewal_invoices,
      COUNT(*) FILTER (WHERE succeeded)::BIGINT AS successful_renewals
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
    COALESCE(rm.successful_renewals, 0)::BIGINT
  FROM locales
  LEFT JOIN trial_metrics AS tm USING (locale)
  LEFT JOIN renewal_metrics AS rm USING (locale)
  ORDER BY (locales.locale = 'unknown'), locales.locale;
$$;

REVOKE ALL ON FUNCTION public.admin_subscription_performance_by_locale(
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_subscription_performance_by_locale(
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TEXT
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_subscription_performance_by_locale(
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TEXT
) TO service_role;

COMMENT ON FUNCTION public.admin_subscription_performance_by_locale(
  TIMESTAMPTZ,
  TIMESTAMPTZ,
  TEXT
) IS
  'Trial-to-paid conversion and first-attempt renewal invoice success by checkout locale for one UTC range.';

-- Renewal-success reporting filters invoice-order attempts by their first
-- locally recorded timestamp. This index keeps those selected-range reads
-- bounded as the recurring ledger grows.
CREATE INDEX IF NOT EXISTS idx_solidgate_invoice_orders_environment_created
  ON public.solidgate_invoice_orders (environment, created_at)
  WHERE subscription_term_number > 0;
