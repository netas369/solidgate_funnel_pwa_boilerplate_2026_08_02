\set ON_ERROR_STOP on

-- Run against a throwaway database with the complete migration chain applied.
\connect - supabase_admin

BEGIN;

INSERT INTO auth.users (id, email)
VALUES
  (
    'f3000000-0000-4000-8000-000000000001',
    'token-origin@example.test'
  ),
  (
    'f3000000-0000-4000-8000-000000000002',
    'token-origin-click@example.test'
  ),
  (
    'f3000000-0000-4000-8000-000000000003',
    'token-origin-wallet@example.test'
  );

INSERT INTO public.sessions (id, user_id, email, locale, last_oto_step)
VALUES
  (
    'f3000000-0000-4000-8000-000000000101',
    'f3000000-0000-4000-8000-000000000001',
    'token-origin@example.test',
    'en',
    '1'
  ),
  (
    'f3000000-0000-4000-8000-000000000102',
    'f3000000-0000-4000-8000-000000000002',
    'token-origin-click@example.test',
    'en',
    '1'
  ),
  (
    'f3000000-0000-4000-8000-000000000103',
    'f3000000-0000-4000-8000-000000000003',
    'token-origin-wallet@example.test',
    'en',
    '1'
  );

SET ROLE service_role;

DO $$
DECLARE
  v_user UUID := 'f3000000-0000-4000-8000-000000000001';
  v_session UUID := 'f3000000-0000-4000-8000-000000000101';
  v_click_user UUID := 'f3000000-0000-4000-8000-000000000002';
  v_click_session UUID := 'f3000000-0000-4000-8000-000000000102';
  v_wallet_user UUID := 'f3000000-0000-4000-8000-000000000003';
  v_wallet_session UUID := 'f3000000-0000-4000-8000-000000000103';
  v_first RECORD;
  v_second RECORD;
  v_click_free RECORD;
  v_wallet_free RECORD;
  v_result TEXT;
BEGIN
  ASSERT has_function_privilege(
    'service_role',
    'public.write_solidgate_session_vault_with_method(text,uuid,uuid,text,text,text,text,text)',
    'EXECUTE'
  ), 'service_role cannot call the method-aware session writer';
  ASSERT NOT has_function_privilege(
    'authenticated',
    'public.write_solidgate_session_vault_with_method(text,uuid,uuid,text,text,text,text,text)',
    'EXECUTE'
  ), 'authenticated can forge session token provenance';
  ASSERT NOT has_function_privilege(
    'anon',
    'public.write_solidgate_account_vault_with_method(text,uuid,text,uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ), 'anon can forge account token provenance';

  SELECT opened.* INTO STRICT v_first
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_session,
    'trial1',
    'BRAND_000000_SUB',
    500,
    'eur',
    'BRAND_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND',
      'funnel_variant', 'main',
      'session_id', v_session::TEXT,
      'product_slug', 'trial1',
      'price_id', 'price-token-origin'
    ),
    'f3000000-0000-4000-8000-000000000011',
    'token-origin@example.test',
    'en',
    'price-token-origin',
    'auth_settle',
    v_user
  ) AS opened;
  UPDATE public.orders
  SET status = 'active',
      amount_cents = 500,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'settle_ok'
  WHERE id = v_first.order_db_id;

  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_session, v_first.order_db_id, v_session::TEXT,
    'wallet-token-one', 'visa', '1111', 'apple-pay'
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1
    FROM public.solidgate_session_vault AS vault
    WHERE vault.payment_environment = 'sandbox'
      AND vault.session_id = v_session
      AND vault.card_token = 'wallet-token-one'
      AND vault.card_original_payment_method = 'apple-pay'
      AND vault.card_source_order_id = v_first.order_db_id
  ), 'exact session source did not persist its token origin';

  -- A poorer same-source replay cannot erase known provenance.
  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_session, v_first.order_db_id, v_session::TEXT,
    'wallet-token-one', 'visa', '1111', NULL
  );
  ASSERT v_result = 'same';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_session
      AND card_original_payment_method = 'apple-pay'
  ), 'same-source null provenance erased known provenance';

  BEGIN
    PERFORM public.write_solidgate_session_vault_with_method(
      'sandbox', v_session, v_first.order_db_id, v_session::TEXT,
      'wallet-token-one', 'visa', '1111', 'google-pay'
    );
    RAISE EXCEPTION 'same source accepted conflicting token provenance';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.write_solidgate_session_vault_with_method(
      'sandbox', v_session, v_first.order_db_id, v_session::TEXT,
      NULL, NULL, NULL, 'card'
    );
    RAISE EXCEPTION 'tokenless input accepted non-null provenance';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    UPDATE public.solidgate_session_vault
    SET card_original_payment_method = 'card'
    WHERE payment_environment = 'sandbox' AND session_id = v_session;
    RAISE EXCEPTION 'direct session provenance update bypassed the source fence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Allocate a strictly newer source. The rolling-compatible old writer must
  -- clear the first source's method instead of inheriting it.
  UPDATE public.orders
  SET status = 'failed',
      amount_cents = 0,
      solidgate_payment_status = 'declined'
  WHERE id = v_first.order_db_id;
  SELECT opened.* INTO STRICT v_second
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_session,
    'trial1',
    'BRAND_000000_SUB',
    500,
    'eur',
    'BRAND_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND',
      'funnel_variant', 'main',
      'session_id', v_session::TEXT,
      'product_slug', 'trial1',
      'price_id', 'price-token-origin'
    ),
    'f3000000-0000-4000-8000-000000000012',
    'token-origin@example.test',
    'en',
    'price-token-origin',
    'auth_settle',
    v_user
  ) AS opened;
  UPDATE public.orders
  SET status = 'active',
      amount_cents = 500,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'settle_ok'
  WHERE id IN (v_first.order_db_id, v_second.order_db_id);

  v_result := public.write_solidgate_session_vault_monotonic(
    'sandbox', v_session, v_second.order_db_id, v_session::TEXT,
    'wallet-token-two', 'mastercard', '2222'
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_session
      AND card_token = 'wallet-token-two'
      AND card_original_payment_method IS NULL
      AND card_source_order_id = v_second.order_db_id
  ), 'new source inherited the previous source token provenance';

  -- The same exact source can enrich null provenance without replacing token.
  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_session, v_second.order_db_id, v_session::TEXT,
    'wallet-token-two', 'mastercard', '2222', 'google-pay'
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_session
      AND card_original_payment_method = 'google-pay'
      AND card_source_order_id = v_second.order_db_id
  ), 'same exact source could not enrich null provenance';

  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_session, v_first.order_db_id, v_session::TEXT,
    'wallet-token-one', 'visa', '1111', 'apple-pay'
  );
  ASSERT v_result = 'stale';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_session_vault
    WHERE payment_environment = 'sandbox'
      AND session_id = v_session
      AND card_token = 'wallet-token-two'
      AND card_original_payment_method = 'google-pay'
      AND card_source_order_id = v_second.order_db_id
  ), 'stale source changed the current token provenance';

  -- Automatic webhook claimed_at is ownership bookkeeping, not auth proof.
  UPDATE public.orders SET claimed_at=NOW() WHERE id=v_second.order_db_id;
  v_result := public.promote_solidgate_session_vault_with_method('sandbox',v_user,v_session);
  ASSERT v_result='unverified', 'claimed_at-only checkout cannot promote an account card';
  v_result := public.write_solidgate_account_vault_with_method(
    'sandbox',v_user,'main_order',v_second.order_db_id,NULL,
    'wallet-token-two','mastercard','2222','google-pay');
  ASSERT v_result='unverified', 'direct method-aware writer cannot bypass authenticated ownership';
  ASSERT NOT EXISTS(SELECT 1 FROM public.solidgate_account_vault
    WHERE payment_environment='sandbox' AND user_id=v_user), 'unverified checkout created account card state';
  -- Simulate the server's successful matching authenticated claim for this
  -- exact source; only then may the already verified payment card promote.
  UPDATE public.orders SET auth_verified_at=NOW() WHERE id=v_second.order_db_id;
  v_result := public.promote_solidgate_session_vault_with_method(
    'sandbox', v_user, v_session
  );
  ASSERT v_result = 'written';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND card_token = 'wallet-token-two'
      AND card_original_payment_method = 'google-pay'
      AND card_source_kind = 'main_order'
      AND card_source_id = v_second.order_db_id::TEXT
  ), 'promotion dropped exact token provenance';

  v_result := public.write_solidgate_account_vault_with_method(
    'sandbox', v_user, 'main_order', v_second.order_db_id, NULL,
    'wallet-token-two', 'mastercard', '2222', NULL
  );
  ASSERT v_result = 'same';
  ASSERT EXISTS (
    SELECT 1 FROM public.solidgate_account_vault
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user
      AND card_original_payment_method = 'google-pay'
  ), 'same-source null provenance erased the promoted account provenance';

  BEGIN
    PERFORM public.write_solidgate_account_vault_with_method(
      'sandbox', v_user, 'main_order', v_second.order_db_id, NULL,
      'wallet-token-two', 'mastercard', '2222', 'apple-pay'
    );
    RAISE EXCEPTION 'account writer accepted conflicting same-source provenance';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.solidgate_account_vault
    SET card_original_payment_method = 'card'
    WHERE payment_environment = 'sandbox' AND user_id = v_user;
    RAISE EXCEPTION 'direct account provenance update bypassed the source fence';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.orders SET user_id=NULL WHERE id=v_second.order_db_id;
  ASSERT (SELECT auth_verified_at IS NULL FROM public.orders WHERE id=v_second.order_db_id),
    'removing the authenticated owner must clear its proof';
  UPDATE public.orders SET user_id=v_user WHERE id=v_second.order_db_id;
  v_result:=public.promote_solidgate_session_vault_with_method('sandbox',v_user,v_session);
  ASSERT v_result='unverified', 'ownership reassignment cannot resurrect historical authentication proof';

  -- special_free access must fail closed until the exact zero-auth source has
  -- both a durable token and reusable provider-owned provenance.
  SELECT opened.* INTO STRICT v_click_free
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_click_session,
    'special_free',
    'BRAND_000000_SUB',
    0,
    'eur',
    'BRAND_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND',
      'funnel_variant', 'special_free',
      'session_id', v_click_session::TEXT,
      'product_slug', 'special_free',
      'price_id', 'price-token-origin-click'
    ),
    'f3000000-0000-4000-8000-000000000021',
    'token-origin-click@example.test',
    'en',
    'price-token-origin-click',
    'auth_0_amount',
    v_click_user
  ) AS opened;
  UPDATE public.orders
  SET status = 'trialing',
      amount_cents = 0,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'auth_ok',
      solidgate_subscription_id = 'sub-token-origin-click'
  WHERE id = v_click_free.order_db_id;

  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_click_session, v_click_free.order_db_id, v_click_session::TEXT,
    'click-token', 'visa', '3333', NULL
  );
  ASSERT v_result = 'written';
  ASSERT NOT public.solidgate_special_free_card_ready(v_click_free.order_db_id),
    'null token provenance satisfied the special_free entitlement guard';

  BEGIN
    PERFORM public.write_solidgate_session_vault_with_method(
      'sandbox', v_click_session, v_click_free.order_db_id, v_click_session::TEXT,
      'click-token', 'visa', '3333', 'unexpected-wallet'
    );
    RAISE EXCEPTION 'invalid token provenance was persisted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT NOT public.solidgate_special_free_card_ready(v_click_free.order_db_id),
    'invalid provenance attempt changed special_free eligibility';

  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_click_session, v_click_free.order_db_id, v_click_session::TEXT,
    'click-token', 'visa', '3333', 'click-to-pay'
  );
  ASSERT v_result = 'written';
  ASSERT NOT public.solidgate_special_free_card_ready(v_click_free.order_db_id),
    'Click to Pay token satisfied the special_free entitlement guard';

  SELECT opened.* INTO STRICT v_wallet_free
  FROM public.open_solidgate_main_checkout_v2(
    'sandbox',
    v_wallet_session,
    'special_free',
    'BRAND_000000_SUB',
    0,
    'eur',
    'BRAND_000000_SUB',
    jsonb_build_object(
      'funnel_code', 'BRAND',
      'funnel_variant', 'special_free',
      'session_id', v_wallet_session::TEXT,
      'product_slug', 'special_free',
      'price_id', 'price-token-origin-wallet'
    ),
    'f3000000-0000-4000-8000-000000000022',
    'token-origin-wallet@example.test',
    'en',
    'price-token-origin-wallet',
    'auth_0_amount',
    v_wallet_user
  ) AS opened;
  UPDATE public.orders
  SET status = 'trialing',
      amount_cents = 0,
      solidgate_refunded_amount_cents = 0,
      solidgate_payment_status = 'auth_ok',
      solidgate_subscription_id = 'sub-token-origin-wallet'
  WHERE id = v_wallet_free.order_db_id;

  v_result := public.write_solidgate_session_vault_with_method(
    'sandbox', v_wallet_session, v_wallet_free.order_db_id, v_wallet_session::TEXT,
    'wallet-free-token', 'visa', '4444', 'apple-pay'
  );
  ASSERT v_result = 'written';
  ASSERT public.solidgate_special_free_card_ready(v_wallet_free.order_db_id),
    'supported Apple Pay provenance did not satisfy the exact special_free guard';
END;
$$;

RESET ROLE;
ROLLBACK;

\echo SOLIDGATE TOKEN ORIGIN PAYMENT TYPE SCENARIOS PASSED
