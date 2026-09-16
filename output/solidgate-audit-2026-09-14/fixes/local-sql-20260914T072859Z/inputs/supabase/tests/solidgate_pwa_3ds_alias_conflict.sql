\set ON_ERROR_STOP on

-- Run against a throwaway database with the full migration chain applied.
-- All fixture mutations are rolled back; only assertions escape this script.
BEGIN;

DO $$
DECLARE
  v_user_id UUID := '24000000-0000-4000-8000-000000000024';
  v_claim_token UUID := '24000000-0000-4000-8000-000000000025';
  v_opened RECORD;
  v_metadata JSONB := jsonb_build_object(
    'funnel_code', 'PWA',
    'funnel_variant', 'member_area',
    'session_id', 'u-24000000-0000-4000-8000-000000000024',
    'product_slug', 'oto4_pdf',
    'locale', 'en'
  );
BEGIN
  DELETE FROM public.solidgate_pwa_purchase_states
  WHERE payment_environment = 'sandbox' AND user_id = v_user_id;
  DELETE FROM public.orders
  WHERE payment_environment = 'sandbox' AND user_id = v_user_id;
  DELETE FROM auth.users WHERE id = v_user_id;

  INSERT INTO auth.users (id, email)
  VALUES (v_user_id, 'solidgate-3ds-conflict@example.invalid');

  SELECT result.* INTO STRICT v_opened
  FROM public.open_solidgate_pwa_purchase_v2(
    'sandbox',
    v_user_id,
    'oto4_pdf',
    'BRANDPDF4_000000_PDF',
    2000,
    'usd',
    v_metadata,
    'saved_card',
    v_claim_token,
    'solidgate-3ds-conflict@example.invalid',
    'en',
    NULL,
    'auth_settle'
  ) AS result;

  -- Model a legacy/cached ACS URL on the exact order and state being
  -- reconciled. A conflicting current provider envelope must erase both.
  UPDATE public.orders
  SET solidgate_verify_url = 'https://verify.example.invalid/stale-order-copy'
  WHERE id = v_opened.order_db_id;
  UPDATE public.solidgate_pwa_purchase_states
  SET last_result_verify_url = 'https://verify.example.invalid/stale-state-copy'
  WHERE payment_environment = 'sandbox'
    AND user_id = v_user_id
    AND product_slug = 'BRANDPDF4_000000_PDF';

  ASSERT public.record_solidgate_pwa_submission_result(
    'sandbox',
    v_user_id,
    'oto4_pdf',
    'BRANDPDF4_000000_PDF',
    v_opened.order_db_id,
    v_opened.solidgate_order_id,
    2000,
    'usd',
    v_claim_token,
    'pending',
    '3ds_verify',
    2000,
    NULL,
    NULL
  ), 'conflicting 3DS aliases did not publish fail-closed pending state';

  ASSERT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = v_opened.order_db_id
      AND status = 'pending'
      AND solidgate_payment_status = '3ds_verify'
      AND solidgate_verify_url IS NULL
  ), 'cached order ACS URL remained reusable after alias conflict';

  ASSERT EXISTS (
    SELECT 1
    FROM public.solidgate_pwa_purchase_states
    WHERE payment_environment = 'sandbox'
      AND user_id = v_user_id
      AND product_slug = 'BRANDPDF4_000000_PDF'
      AND claim_kind IS NULL
      AND last_result_kind = 'pending'
      AND last_result_verify_url IS NULL
  ), 'cached state ACS URL remained reusable after alias conflict';

  RAISE NOTICE 'SOLIDGATE PWA 3DS ALIAS-CONFLICT SCENARIO PASSED';
END $$;

ROLLBACK;
