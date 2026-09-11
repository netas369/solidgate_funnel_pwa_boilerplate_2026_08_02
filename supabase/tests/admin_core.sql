\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  result RECORD;
  support_actor UUID := gen_random_uuid();
  support_target UUID := gen_random_uuid();
  idempotency UUID := gen_random_uuid();
BEGIN
  ASSERT public.consume_admin_rate_limit(
    'support_lookup', repeat('a', 64), 2, 300
  ), 'first rate-limit token should be allowed';
  ASSERT public.consume_admin_rate_limit(
    'support_lookup', repeat('a', 64), 2, 300
  ), 'second rate-limit token should be allowed';
  ASSERT NOT public.consume_admin_rate_limit(
    'support_lookup', repeat('a', 64), 2, 300
  ), 'third rate-limit token should be denied';

  INSERT INTO auth.users (id, email)
  VALUES (support_actor, 'operator@example.test'), (support_target, 'customer@example.test');

  INSERT INTO public.support_action_audit (
    action,
    customer_email_hash,
    customer_user_id,
    actor_user_id,
    idempotency_key
  ) VALUES (
    'send_login_code', repeat('b', 64), support_target, support_actor, idempotency
  );

  BEGIN
    INSERT INTO public.support_action_audit (
      action,
      customer_email_hash,
      customer_user_id,
      actor_user_id,
      idempotency_key
    ) VALUES (
      'send_login_code', repeat('b', 64), support_target, support_actor, idempotency
    );
    RAISE EXCEPTION 'duplicate idempotency key was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  ASSERT NOT has_table_privilege('anon', 'public.admin_rate_limit_events', 'SELECT'),
    'anon must not read admin rate limits';
  ASSERT NOT has_table_privilege('authenticated', 'public.support_action_audit', 'SELECT'),
    'authenticated users must not read support audits';

  INSERT INTO public.sessions (id, email, locale, created_at)
  VALUES
    ('10000000-0000-4000-8000-000000000001', 'one@example.test', 'en', now() - interval '20 days'),
    ('10000000-0000-4000-8000-000000000002', 'two@example.test', 'lt', now() - interval '20 days'),
    ('10000000-0000-4000-8000-000000000003', 'recent@example.test', 'en', now() - interval '2 days');

  INSERT INTO public.orders (
    session_id, amount_cents, currency, status, product_name, product_slug,
    psp, payment_environment, solidgate_subscription_id, created_at
  ) VALUES
    ('10000000-0000-4000-8000-000000000001', 500, 'eur', 'active', 'MAIN', 'MAIN', 'test', 'production', 'sub-one', now() - interval '20 days'),
    ('10000000-0000-4000-8000-000000000002', 500, 'eur', 'active', 'MAIN', 'MAIN', 'test', 'production', 'sub-two', now() - interval '20 days'),
    ('10000000-0000-4000-8000-000000000003', 500, 'eur', 'trialing', 'MAIN', 'MAIN', 'test', 'production', 'sub-recent', now() - interval '2 days'),
    ('10000000-0000-4000-8000-000000000001', 1000, 'eur', 'completed', 'ADDON', 'ADDON', 'test', 'production', 'sub-addon', now() - interval '19 days');

  INSERT INTO public.solidgate_invoice_orders (
    environment, solidgate_order_id, solidgate_invoice_id,
    solidgate_subscription_id, subscription_term_number, status,
    amount_cents, currency, source_created_at
  ) VALUES
    ('production', 'renew-one-a', 'invoice-one', 'sub-one', 1, 'declined', 5900, 'eur', now() - interval '5 days'),
    ('production', 'renew-one-b', 'invoice-one', 'sub-one', 1, 'settle_ok', 5900, 'eur', now() - interval '4 days'),
    ('production', 'renew-two-a', 'invoice-two', 'sub-two', 1, 'approved', 5900, 'eur', now() - interval '5 days');

  INSERT INTO public.renewal_events (
    payment_environment, solidgate_invoice_id, solidgate_subscription_id,
    solidgate_order_id, subscription_term_number, amount_cents, currency, created_at
  ) VALUES
    ('production', 'invoice-one', 'sub-one', 'renew-one-b', 1, 5900, 'eur', now() - interval '4 days'),
    ('production', 'invoice-two', 'sub-two', 'renew-two-a', 1, 5900, 'eur', now() - interval '5 days');

  SELECT * INTO result
  FROM public.admin_subscription_performance_by_locale_v2(
    now() - interval '30 days', now(), ARRAY['MAIN'], 'production', 7
  )
  WHERE locale = 'en';

  ASSERT result.trial_starts = 1,
    'immature en trial must be excluded from the denominator';
  ASSERT result.trial_conversions = 1, 'mature en trial should convert';
  ASSERT result.renewal_invoices = 1, 'en invoice retries must deduplicate';
  ASSERT result.first_attempt_successful_renewals = 0,
    'declined first attempt must not count as first-try success';
  ASSERT result.successful_renewals = 1, 'recovered invoice should count as eventual success';
  ASSERT result.recovered_renewals = 1, 'recovered invoice should be identified';

  SELECT * INTO result
  FROM public.admin_subscription_performance_by_locale_v2(
    now() - interval '30 days', now(), ARRAY['MAIN'], 'production', 7
  )
  WHERE locale = 'lt';
  ASSERT result.first_attempt_successful_renewals = 1,
    'approved first attempt should count as first-try success';
  ASSERT result.recovered_renewals = 0,
    'first-try success must not count as recovered';

  SELECT * INTO result
  FROM public.admin_customer_ltv_by_currency_v2('production')
  WHERE currency = 'eur';
  ASSERT result.customer_count = 3,
    'LTV population should deduplicate paying customer identities';
  ASSERT result.net_amount_cents = 14300,
    'LTV should include initial orders, add-ons, and each successful renewal once';

  RAISE NOTICE 'admin_core.sql PASSED';
END;
$$;

ROLLBACK;
