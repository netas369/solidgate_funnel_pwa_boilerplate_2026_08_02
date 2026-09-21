-- Email matching and webhook ownership assignment are not authentication.
-- Only server code handling a matching verified account session/OTP claim may
-- populate this marker; legacy claimed_at values are intentionally not copied.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS auth_verified_at TIMESTAMPTZ;
COMMENT ON COLUMN public.orders.auth_verified_at IS
  'Time a matching authenticated account session or email OTP claimed this exact order. Never inferred from checkout email or webhook ownership.';

-- Financial evidence is independent from checkout quotes and entitlement state.
-- All amounts are integer minor currency units. A chargeback is a reserve over
-- the original payment; refund and dispute may describe overlapping funds, so
-- effective reversal = greatest(cumulative refund, active chargeback reserve).
CREATE TABLE IF NOT EXISTS public.solidgate_payment_balances (
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  solidgate_order_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  user_id UUID,
  solidgate_invoice_id TEXT,
  solidgate_subscription_id TEXT,
  subscription_term_number INTEGER CHECK (subscription_term_number >= 0),
  product_key TEXT,
  currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  quoted_amount_cents INTEGER CHECK (quoted_amount_cents >= 0),
  captured_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (captured_amount_cents >= 0),
  refunded_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_amount_cents >= 0),
  chargeback_id TEXT,
  chargeback_status TEXT,
  chargeback_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (chargeback_amount_cents >= 0),
  chargeback_occurred_at TIMESTAMPTZ,
  net_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (net_amount_cents >= 0),
  payment_status TEXT,
  payment_status_at TIMESTAMPTZ,
  first_captured_at TIMESTAMPTZ,
  first_captured_at_source TEXT,
  capture_evidence_source TEXT NOT NULL DEFAULT 'provider',
  invoice_created_at TIMESTAMPTZ,
  period_start_at TIMESTAMPTZ,
  period_end_at TIMESTAMPTZ,
  needs_reconciliation BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, solidgate_order_id),
  CHECK (net_amount_cents = GREATEST(0, captured_amount_cents - GREATEST(refunded_amount_cents, chargeback_amount_cents)))
);
ALTER TABLE public.solidgate_payment_balances ADD COLUMN IF NOT EXISTS first_captured_at_source TEXT;
ALTER TABLE public.solidgate_payment_balances ADD COLUMN IF NOT EXISTS capture_evidence_source TEXT NOT NULL DEFAULT 'provider';
CREATE INDEX IF NOT EXISTS solidgate_payment_balances_subscription_idx
  ON public.solidgate_payment_balances (environment, solidgate_subscription_id, subscription_term_number);
CREATE INDEX IF NOT EXISTS solidgate_payment_balances_order_idx
  ON public.solidgate_payment_balances (order_id);
CREATE TABLE IF NOT EXISTS public.solidgate_financial_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  event_key TEXT NOT NULL,
  solidgate_order_id TEXT NOT NULL,
  solidgate_invoice_id TEXT,
  solidgate_subscription_id TEXT,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  user_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL,
  occurred_at_source TEXT NOT NULL CHECK (occurred_at_source IN ('provider_operation', 'provider_event', 'legacy_observation', 'received_at')),
  evidence_source TEXT NOT NULL DEFAULT 'provider' CHECK (evidence_source IN ('provider', 'legacy_projection')),
  currency TEXT NOT NULL,
  captured_delta_cents BIGINT NOT NULL,
  refunded_delta_cents BIGINT NOT NULL,
  chargeback_delta_cents BIGINT NOT NULL,
  net_delta_cents BIGINT NOT NULL,
  resulting_captured_amount_cents INTEGER NOT NULL,
  resulting_refunded_amount_cents INTEGER NOT NULL,
  resulting_chargeback_amount_cents INTEGER NOT NULL,
  resulting_net_amount_cents INTEGER NOT NULL,
  provider_transaction_ids JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(provider_transaction_ids) = 'array'),
  facts JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment, event_key, solidgate_order_id)
);
CREATE INDEX IF NOT EXISTS solidgate_financial_movements_time_idx
  ON public.solidgate_financial_movements (environment, occurred_at, currency);
CREATE INDEX IF NOT EXISTS solidgate_financial_movements_order_idx
  ON public.solidgate_financial_movements (order_id, occurred_at);
ALTER TABLE public.solidgate_payment_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solidgate_financial_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_payment_balances, public.solidgate_financial_movements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.solidgate_payment_balances TO service_role;
GRANT SELECT, INSERT ON public.solidgate_financial_movements TO service_role;

CREATE OR REPLACE FUNCTION public.reject_solidgate_history_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Solidgate financial and subscription history is append-only' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS solidgate_financial_movements_immutable ON public.solidgate_financial_movements;
CREATE TRIGGER solidgate_financial_movements_immutable BEFORE UPDATE OR DELETE ON public.solidgate_financial_movements
  FOR EACH ROW EXECUTE FUNCTION public.reject_solidgate_history_mutation();
REVOKE ALL ON FUNCTION public.reject_solidgate_history_mutation() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.solidgate_capture_transactions (
  environment TEXT NOT NULL CHECK(environment IN ('production','sandbox')),
  solidgate_order_id TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  occurred_at TIMESTAMPTZ NOT NULL,
  occurred_at_source TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(environment,solidgate_order_id,provider_transaction_id),
  FOREIGN KEY(environment,solidgate_order_id) REFERENCES public.solidgate_payment_balances(environment,solidgate_order_id)
);
ALTER TABLE public.solidgate_capture_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_capture_transactions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.solidgate_capture_transactions TO service_role;
DROP TRIGGER IF EXISTS solidgate_capture_transactions_immutable ON public.solidgate_capture_transactions;
CREATE TRIGGER solidgate_capture_transactions_immutable BEFORE UPDATE OR DELETE ON public.solidgate_capture_transactions
  FOR EACH ROW EXECUTE FUNCTION public.reject_solidgate_history_mutation();

CREATE OR REPLACE FUNCTION public.apply_solidgate_financial_event(
  p_environment TEXT,
  p_event_key TEXT,
  p_solidgate_order_id TEXT,
  p_facts JSONB,
  p_analytics JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_old public.solidgate_payment_balances%ROWTYPE;
  v_new public.solidgate_payment_balances%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_mapping public.solidgate_invoice_orders%ROWTYPE;
  v_movement public.solidgate_financial_movements%ROWTYPE;
  v_occurred TIMESTAMPTZ := COALESCE(NULLIF(p_facts->>'occurred_at','')::TIMESTAMPTZ, NOW());
  v_chargeback_at TIMESTAMPTZ;
  v_initial BOOLEAN;
  v_reversed BOOLEAN;
  v_financial_status TEXT;
  v_properties JSONB;
  v_capture_delta BIGINT;
  v_refund_delta BIGINT;
  v_chargeback_delta BIGINT;
  v_net_delta BIGINT;
  v_financial_marker TEXT;
  v_transaction JSONB;
  v_transaction_sum BIGINT;
  v_incoming_captured INTEGER;
BEGIN
  IF p_environment NOT IN ('production', 'sandbox') OR NULLIF(BTRIM(p_event_key),'') IS NULL
     OR NULLIF(BTRIM(p_solidgate_order_id),'') IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
     OR NULLIF(p_facts->>'order_db_id','') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate financial event' USING ERRCODE = '22023';
  END IF;
  -- Parent lock also serializes different successful attempts of one invoice,
  -- lifecycle barriers, account ownership, and rolling legacy order writers.
  SELECT * INTO v_order FROM public.orders
    WHERE id = (p_facts->>'order_db_id')::UUID FOR UPDATE;
  IF NOT FOUND OR v_order.psp <> 'solidgate' OR v_order.payment_environment <> p_environment THEN
    RAISE EXCEPTION 'financial event parent order mismatch' USING ERRCODE = '23514';
  END IF;
  v_initial := v_order.solidgate_order_id = p_solidgate_order_id;
  IF v_order.solidgate_subscription_id IS NOT NULL AND NULLIF(p_facts->>'subscription_id','') IS NOT NULL
    AND v_order.solidgate_subscription_id<>p_facts->>'subscription_id' THEN
    RAISE EXCEPTION 'financial subscription ownership mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT v_initial AND (NULLIF(p_facts->>'subscription_id','') IS NULL
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_facts->>'subscription_id'
     OR NULLIF(p_facts->>'invoice_id','') IS NULL) THEN
    RAISE EXCEPTION 'renewal financial identity incomplete' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_movement FROM public.solidgate_financial_movements
    WHERE environment = p_environment AND event_key = p_event_key AND solidgate_order_id = p_solidgate_order_id;
  IF FOUND THEN
    -- Replays expose current barriers, while keeping the event's original
    -- immutable deltas. An old paid event cannot report pre-refund money.
    SELECT * INTO STRICT v_old FROM public.solidgate_payment_balances
      WHERE environment=p_environment AND solidgate_order_id=p_solidgate_order_id;
    RETURN jsonb_build_object('applied',FALSE,'captured_amount_cents',v_old.captured_amount_cents,
      'refunded_amount_cents',v_old.refunded_amount_cents,'chargeback_amount_cents',v_old.chargeback_amount_cents,
      'net_amount_cents',v_old.net_amount_cents,'payment_status',v_old.payment_status,
      'status',CASE WHEN v_old.chargeback_amount_cents>0 THEN 'disputed'
        WHEN v_old.refunded_amount_cents>0 AND v_old.net_amount_cents=0 THEN 'refunded'
        WHEN v_old.refunded_amount_cents>0 THEN 'partially_refunded' ELSE 'paid' END,
      'captured_delta_cents',v_movement.captured_delta_cents,
      'refunded_delta_cents',v_movement.refunded_delta_cents,'net_delta_cents',v_movement.net_delta_cents);
  END IF;
  INSERT INTO public.solidgate_payment_balances (environment, solidgate_order_id, order_id, user_id, currency)
    VALUES (p_environment, p_solidgate_order_id, v_order.id, v_order.user_id, LOWER(COALESCE(p_facts->>'currency', v_order.currency)))
    ON CONFLICT DO NOTHING;
  SELECT * INTO v_old FROM public.solidgate_payment_balances
    WHERE environment = p_environment AND solidgate_order_id = p_solidgate_order_id FOR UPDATE;
  IF v_old.order_id <> v_order.id OR v_old.currency <> LOWER(COALESCE(p_facts->>'currency', v_order.currency))
     OR (v_old.solidgate_invoice_id IS NOT NULL AND NULLIF(p_facts->>'invoice_id','') IS NOT NULL
       AND v_old.solidgate_invoice_id <> p_facts->>'invoice_id')
     OR (v_old.solidgate_subscription_id IS NOT NULL AND NULLIF(p_facts->>'subscription_id','') IS NOT NULL
       AND v_old.solidgate_subscription_id <> p_facts->>'subscription_id') THEN
    RAISE EXCEPTION 'financial currency or provider identity cannot change' USING ERRCODE = '23514';
  END IF;
  v_new := v_old;
  -- Adopt durable reversal facts from pre-ledger invoice mappings, including
  -- refunds received before any paid renewal row existed during the upgrade.
  SELECT * INTO v_mapping FROM public.solidgate_invoice_orders
    WHERE environment=p_environment AND solidgate_order_id=p_solidgate_order_id FOR UPDATE;
  IF FOUND THEN
    IF (NULLIF(p_facts->>'invoice_id','') IS NOT NULL AND v_mapping.solidgate_invoice_id<>p_facts->>'invoice_id')
      OR (NULLIF(p_facts->>'subscription_id','') IS NOT NULL AND v_mapping.solidgate_subscription_id<>p_facts->>'subscription_id')
      OR LOWER(v_mapping.currency)<>v_new.currency THEN
      RAISE EXCEPTION 'existing invoice mapping identity mismatch' USING ERRCODE='23514';
    END IF;
    IF v_old.chargeback_status IS NULL AND v_mapping.chargeback_status IS NOT NULL THEN
      v_new.chargeback_id:=v_mapping.chargeback_id;
      v_new.chargeback_status:=v_mapping.chargeback_status;
      v_new.chargeback_amount_cents:=CASE WHEN v_mapping.chargeback_status IN ('reversed','resolved_reversal') THEN 0 ELSE v_mapping.chargeback_amount_cents END;
      v_new.chargeback_occurred_at:=COALESCE(v_mapping.event_created_at,v_mapping.source_updated_at,v_mapping.created_at);
    END IF;
  END IF;
  v_new.user_id := COALESCE(v_order.user_id, v_old.user_id);
  v_new.solidgate_invoice_id := COALESCE(v_old.solidgate_invoice_id, NULLIF(p_facts->>'invoice_id',''));
  v_new.solidgate_subscription_id := COALESCE(v_old.solidgate_subscription_id, NULLIF(p_facts->>'subscription_id',''), v_order.solidgate_subscription_id);
  v_new.subscription_term_number := COALESCE((p_facts->>'subscription_term_number')::INTEGER, v_old.subscription_term_number);
  IF v_old.subscription_term_number IS NOT NULL AND v_new.subscription_term_number <> v_old.subscription_term_number THEN
    RAISE EXCEPTION 'financial invoice term cannot change' USING ERRCODE = '23514';
  END IF;
  v_new.product_key := COALESCE(v_old.product_key, p_facts->>'product_key', v_order.product_slug);
  v_new.quoted_amount_cents := COALESCE(v_old.quoted_amount_cents, (p_facts->>'quoted_amount_cents')::INTEGER,
    CASE WHEN v_initial THEN v_order.solidgate_original_amount_cents END);
  IF COALESCE((p_facts->>'captured_amount_cents')::INTEGER, 0) < 0
     OR COALESCE((p_facts->>'refunded_amount_cents')::INTEGER, 0) < 0
     OR COALESCE((p_facts->>'chargeback_amount_cents')::INTEGER, 0) < 0 THEN
    RAISE EXCEPTION 'negative provider amount' USING ERRCODE = '22023';
  END IF;
  IF p_facts ? 'capture_transactions' THEN
    IF jsonb_typeof(p_facts->'capture_transactions')<>'array' THEN
      RAISE EXCEPTION 'invalid capture transactions' USING ERRCODE='22023';
    END IF;
    FOR v_transaction IN SELECT value FROM jsonb_array_elements(p_facts->'capture_transactions') LOOP
      IF NULLIF(v_transaction->>'id','') IS NULL OR (v_transaction->>'amount_cents')::INTEGER IS NULL
        OR (v_transaction->>'amount_cents')::INTEGER<0
        OR LOWER(COALESCE(v_transaction->>'currency',v_new.currency))<>v_new.currency THEN
        RAISE EXCEPTION 'invalid capture transaction identity' USING ERRCODE='23514';
      END IF;
      INSERT INTO public.solidgate_capture_transactions(environment,solidgate_order_id,provider_transaction_id,currency,amount_cents,occurred_at,occurred_at_source)
        VALUES(p_environment,p_solidgate_order_id,v_transaction->>'id',v_new.currency,(v_transaction->>'amount_cents')::INTEGER,
          COALESCE(NULLIF(v_transaction->>'occurred_at','')::TIMESTAMPTZ,v_occurred),
          CASE WHEN NULLIF(v_transaction->>'occurred_at','') IS NULL THEN 'provider_event' ELSE 'provider_operation' END)
        ON CONFLICT DO NOTHING;
      IF EXISTS(SELECT 1 FROM public.solidgate_capture_transactions WHERE environment=p_environment
        AND solidgate_order_id=p_solidgate_order_id AND provider_transaction_id=v_transaction->>'id'
        AND (amount_cents<>(v_transaction->>'amount_cents')::INTEGER OR currency<>v_new.currency)) THEN
        RAISE EXCEPTION 'capture transaction amount is immutable' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  SELECT COALESCE(SUM(amount_cents),0) INTO v_transaction_sum FROM public.solidgate_capture_transactions
    WHERE environment=p_environment AND solidgate_order_id=p_solidgate_order_id;
  v_incoming_captured:=GREATEST(COALESCE((p_facts->>'captured_amount_cents')::INTEGER,0),v_transaction_sum::INTEGER);
  v_new.captured_amount_cents := CASE WHEN v_old.capture_evidence_source='legacy_projection' AND p_facts ? 'captured_amount_cents'
    THEN v_incoming_captured
    ELSE GREATEST(v_old.captured_amount_cents,v_incoming_captured) END;
  IF p_facts ? 'captured_amount_cents' THEN v_new.capture_evidence_source:='provider'; END IF;
  v_new.refunded_amount_cents := GREATEST(v_old.refunded_amount_cents,COALESCE(v_mapping.refunded_amount_cents,0),COALESCE((p_facts->>'refunded_amount_cents')::INTEGER,0));
  v_chargeback_at := COALESCE(NULLIF(p_facts->>'chargeback_occurred_at','')::TIMESTAMPTZ, v_occurred);
  IF NULLIF(p_facts->>'chargeback_status','') IS NOT NULL THEN
    v_reversed := LOWER(p_facts->>'chargeback_status') IN ('reversed', 'resolved_reversal');
    IF v_new.chargeback_occurred_at IS NULL OR v_chargeback_at > v_new.chargeback_occurred_at
       OR (v_chargeback_at = v_new.chargeback_occurred_at AND
          (v_reversed OR COALESCE(v_new.chargeback_status,'') NOT IN ('reversed','resolved_reversal'))) THEN
      v_new.chargeback_id := COALESCE(p_facts->>'chargeback_id',v_new.chargeback_id);
      v_new.chargeback_status := LOWER(p_facts->>'chargeback_status');
      v_new.chargeback_amount_cents := CASE WHEN v_reversed THEN 0 ELSE GREATEST(v_new.chargeback_amount_cents,COALESCE((p_facts->>'chargeback_amount_cents')::INTEGER,0)) END;
      v_new.chargeback_occurred_at := v_chargeback_at;
    END IF;
  END IF;
  v_new.net_amount_cents := GREATEST(0, v_new.captured_amount_cents - GREATEST(v_new.refunded_amount_cents, v_new.chargeback_amount_cents));
  v_new.needs_reconciliation := GREATEST(v_new.refunded_amount_cents, v_new.chargeback_amount_cents) > v_new.captured_amount_cents;
  IF NULLIF(p_facts->>'payment_status','') IS NOT NULL AND
     (v_old.payment_status_at IS NULL OR v_occurred >= v_old.payment_status_at) THEN
    v_new.payment_status := p_facts->>'payment_status';
    v_new.payment_status_at := v_occurred;
  END IF;
  -- Reversal and proven capture facts outrank transient/late status labels.
  IF v_new.refunded_amount_cents > 0 THEN v_new.payment_status := 'refunded';
  ELSIF v_new.captured_amount_cents > 0 AND COALESCE(v_new.payment_status,'') NOT IN ('settle_ok','partial_settled') THEN
    v_new.payment_status := CASE WHEN v_new.captured_amount_cents >= COALESCE(v_new.quoted_amount_cents, v_new.captured_amount_cents) THEN 'settle_ok' ELSE 'partial_settled' END;
  END IF;
  IF v_new.captured_amount_cents > 0 AND p_facts ? 'captured_amount_cents' THEN
    IF v_old.first_captured_at IS NULL OR (p_facts->>'occurred_at_source'='provider_operation' AND v_old.first_captured_at_source IS DISTINCT FROM 'provider_operation') THEN
      v_new.first_captured_at:=v_occurred;
      v_new.first_captured_at_source:=COALESCE(p_facts->>'occurred_at_source','provider_event');
    ELSIF COALESCE(p_facts->>'occurred_at_source','provider_event')=v_old.first_captured_at_source THEN
      v_new.first_captured_at:=LEAST(v_old.first_captured_at,v_occurred);
    END IF;
  END IF;
  v_new.invoice_created_at := COALESCE(v_old.invoice_created_at, NULLIF(p_facts->>'invoice_created_at','')::TIMESTAMPTZ);
  v_new.period_start_at := COALESCE(NULLIF(p_facts->>'period_start_at','')::TIMESTAMPTZ, v_old.period_start_at);
  v_new.period_end_at := GREATEST(NULLIF(p_facts->>'period_end_at','')::TIMESTAMPTZ, v_old.period_end_at);
  v_capture_delta := v_new.captured_amount_cents::BIGINT - v_old.captured_amount_cents;
  v_refund_delta := v_new.refunded_amount_cents::BIGINT - v_old.refunded_amount_cents;
  v_chargeback_delta := v_new.chargeback_amount_cents::BIGINT - v_old.chargeback_amount_cents;
  v_net_delta := v_capture_delta - (GREATEST(v_new.refunded_amount_cents, v_new.chargeback_amount_cents)::BIGINT - GREATEST(v_old.refunded_amount_cents, v_old.chargeback_amount_cents));
  v_financial_status := CASE WHEN v_new.chargeback_amount_cents > 0 THEN 'disputed'
    WHEN v_new.refunded_amount_cents > 0 AND v_new.net_amount_cents = 0 THEN 'refunded'
    WHEN v_new.refunded_amount_cents > 0 THEN 'partially_refunded'
    WHEN v_new.chargeback_status IN ('reversed','resolved_reversal') THEN 'chargeback_reversed'
    ELSE 'paid' END;
  UPDATE public.solidgate_payment_balances SET
    user_id = v_new.user_id, solidgate_invoice_id = v_new.solidgate_invoice_id,
    solidgate_subscription_id = v_new.solidgate_subscription_id, subscription_term_number = v_new.subscription_term_number,
    product_key = v_new.product_key, quoted_amount_cents = v_new.quoted_amount_cents,
    captured_amount_cents = v_new.captured_amount_cents, refunded_amount_cents = v_new.refunded_amount_cents,
    chargeback_id = v_new.chargeback_id, chargeback_status = v_new.chargeback_status,
    chargeback_amount_cents = v_new.chargeback_amount_cents, chargeback_occurred_at = v_new.chargeback_occurred_at,
    net_amount_cents = v_new.net_amount_cents, payment_status = v_new.payment_status,
    payment_status_at = v_new.payment_status_at, first_captured_at = v_new.first_captured_at,
    first_captured_at_source = v_new.first_captured_at_source, capture_evidence_source = v_new.capture_evidence_source,
    invoice_created_at = v_new.invoice_created_at, period_start_at = v_new.period_start_at,
    period_end_at = v_new.period_end_at, needs_reconciliation = v_new.needs_reconciliation, updated_at = NOW()
  WHERE environment = p_environment AND solidgate_order_id = p_solidgate_order_id;
  IF v_initial THEN
    v_financial_marker := pg_catalog.current_setting('app.solidgate_financial_order',TRUE);
    PERFORM pg_catalog.set_config('app.solidgate_financial_order',v_order.id::TEXT,TRUE);
    UPDATE public.orders SET
      -- Uncaptured checkout rows retain the quote used by existing openers.
      amount_cents = CASE WHEN v_new.captured_amount_cents > 0 OR v_new.refunded_amount_cents > 0 OR v_new.chargeback_amount_cents > 0 THEN v_new.net_amount_cents ELSE amount_cents END,
      solidgate_refunded_amount_cents = v_new.refunded_amount_cents,
      solidgate_chargeback_id = v_new.chargeback_id, solidgate_chargeback_status = v_new.chargeback_status,
      solidgate_chargeback_amount_cents = v_new.chargeback_amount_cents,
      solidgate_pre_dispute_status = CASE WHEN v_new.chargeback_amount_cents > 0 AND status <> 'disputed' THEN status ELSE solidgate_pre_dispute_status END,
      solidgate_payment_status = COALESCE(v_new.payment_status, solidgate_payment_status),
      status = CASE WHEN v_new.chargeback_amount_cents > 0 THEN 'disputed'
        WHEN v_new.refunded_amount_cents > 0 AND v_new.captured_amount_cents > 0 AND v_new.net_amount_cents = 0 THEN 'refunded' ELSE status END
    WHERE id = v_order.id;
    PERFORM pg_catalog.set_config('app.solidgate_financial_order',COALESCE(v_financial_marker,''),TRUE);
  END IF;
  IF v_new.solidgate_invoice_id IS NOT NULL AND v_new.solidgate_subscription_id IS NOT NULL THEN
    SELECT * INTO v_mapping FROM public.solidgate_invoice_orders
      WHERE environment=p_environment AND solidgate_order_id=p_solidgate_order_id FOR UPDATE;
    IF FOUND AND (v_mapping.solidgate_invoice_id<>v_new.solidgate_invoice_id
      OR v_mapping.solidgate_subscription_id<>v_new.solidgate_subscription_id
      OR LOWER(v_mapping.currency)<>v_new.currency) THEN
      RAISE EXCEPTION 'existing invoice mapping identity mismatch' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.solidgate_invoice_orders (environment, solidgate_order_id, solidgate_invoice_id,
      solidgate_subscription_id, subscription_term_number, status, amount_cents, currency, operation,
      product_price_id, order_metadata, refunded_amount_cents, chargeback_id, chargeback_status, chargeback_amount_cents,
      source_created_at, source_updated_at, event_created_at)
    VALUES (p_environment, p_solidgate_order_id, v_new.solidgate_invoice_id, v_new.solidgate_subscription_id,
      v_new.subscription_term_number, COALESCE(v_new.payment_status, 'processing'), COALESCE(v_new.quoted_amount_cents,v_new.captured_amount_cents),
      v_new.currency, p_facts->>'operation', p_facts->>'product_price_id', COALESCE(p_facts->'order_metadata','{}'::JSONB),
      v_new.refunded_amount_cents, v_new.chargeback_id, v_new.chargeback_status, v_new.chargeback_amount_cents,
      NULLIF(p_facts->>'source_created_at','')::TIMESTAMPTZ, NULLIF(p_facts->>'source_updated_at','')::TIMESTAMPTZ, v_occurred)
    ON CONFLICT (environment, solidgate_order_id) DO UPDATE SET
      status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents,
      subscription_term_number = COALESCE(EXCLUDED.subscription_term_number, solidgate_invoice_orders.subscription_term_number),
      operation = COALESCE(EXCLUDED.operation, solidgate_invoice_orders.operation),
      product_price_id = COALESCE(EXCLUDED.product_price_id, solidgate_invoice_orders.product_price_id),
      order_metadata = solidgate_invoice_orders.order_metadata || EXCLUDED.order_metadata,
      refunded_amount_cents = EXCLUDED.refunded_amount_cents, chargeback_id = EXCLUDED.chargeback_id,
      chargeback_status = EXCLUDED.chargeback_status, chargeback_amount_cents = EXCLUDED.chargeback_amount_cents,
      source_created_at = COALESCE(solidgate_invoice_orders.source_created_at, EXCLUDED.source_created_at),
      source_updated_at = GREATEST(solidgate_invoice_orders.source_updated_at, EXCLUDED.source_updated_at),
      event_created_at = GREATEST(solidgate_invoice_orders.event_created_at, EXCLUDED.event_created_at), updated_at = NOW();
    IF NOT v_initial AND v_new.subscription_term_number > 0 AND v_new.captured_amount_cents > 0 THEN
      -- One row per invoice; if a provider invoice has more than one settled
      -- attempt, immutable movements still preserve every actual collection.
      INSERT INTO public.renewal_events (payment_environment, solidgate_invoice_id, solidgate_subscription_id,
        solidgate_order_id, subscription_term_number, amount_cents, gross_amount_cents, refunded_amount_cents,
        currency, product_key, status, chargeback_id, chargeback_status, chargeback_amount_cents,
        invoice_created_at, event_created_at, created_at)
      SELECT p_environment, v_new.solidgate_invoice_id, v_new.solidgate_subscription_id,
        p_solidgate_order_id, v_new.subscription_term_number, SUM(net_amount_cents)::INTEGER,
        SUM(captured_amount_cents)::INTEGER, SUM(refunded_amount_cents)::INTEGER,
        v_new.currency, v_new.product_key,
        CASE WHEN SUM(chargeback_amount_cents) > 0 THEN 'disputed'
          WHEN SUM(refunded_amount_cents) > 0 AND SUM(net_amount_cents) = 0 THEN 'refunded'
          WHEN SUM(refunded_amount_cents) > 0 THEN 'partially_refunded' ELSE v_financial_status END,
        v_new.chargeback_id, v_new.chargeback_status, SUM(chargeback_amount_cents)::INTEGER,
        v_new.invoice_created_at, v_occurred, MIN(first_captured_at)
      FROM public.solidgate_payment_balances
      WHERE environment = p_environment AND solidgate_invoice_id = v_new.solidgate_invoice_id
      ON CONFLICT (payment_environment, solidgate_invoice_id) DO UPDATE SET
        amount_cents = EXCLUDED.amount_cents, gross_amount_cents = EXCLUDED.gross_amount_cents,
        refunded_amount_cents = EXCLUDED.refunded_amount_cents, status = EXCLUDED.status,
        chargeback_id = EXCLUDED.chargeback_id, chargeback_status = EXCLUDED.chargeback_status,
        chargeback_amount_cents = EXCLUDED.chargeback_amount_cents,
        event_created_at = GREATEST(renewal_events.event_created_at, EXCLUDED.event_created_at),
        created_at = LEAST(renewal_events.created_at, EXCLUDED.created_at);
    END IF;
  END IF;
  INSERT INTO public.solidgate_financial_movements (environment,event_key,solidgate_order_id,solidgate_invoice_id,
    solidgate_subscription_id,order_id,user_id,occurred_at,occurred_at_source,evidence_source,currency,
    captured_delta_cents,refunded_delta_cents,chargeback_delta_cents,net_delta_cents,
    resulting_captured_amount_cents,resulting_refunded_amount_cents,resulting_chargeback_amount_cents,resulting_net_amount_cents,
    provider_transaction_ids,facts)
  VALUES (p_environment,p_event_key,p_solidgate_order_id,v_new.solidgate_invoice_id,v_new.solidgate_subscription_id,
    v_order.id,v_new.user_id,v_occurred,COALESCE(p_facts->>'occurred_at_source',CASE WHEN p_facts->>'occurred_at' IS NULL THEN 'received_at' ELSE 'provider_event' END),
    COALESCE(p_facts->>'evidence_source','provider'),v_new.currency,v_capture_delta,v_refund_delta,v_chargeback_delta,v_net_delta,
    v_new.captured_amount_cents,v_new.refunded_amount_cents,v_new.chargeback_amount_cents,v_new.net_amount_cents,
    COALESCE(p_facts->'provider_transaction_ids','[]'::JSONB),p_facts);
  IF p_analytics IS NOT NULL THEN
    v_properties := COALESCE(p_analytics->'properties','{}'::JSONB) || jsonb_build_object(
      'revenue',CASE WHEN p_analytics->>'event_name' IN ('subscription_started','oto_subscription_started','purchase_completed','subscription_renewed')
        THEN v_new.captured_amount_cents ELSE v_net_delta END,'refund_amount_cents',v_refund_delta,
      'captured_amount_cents',v_new.captured_amount_cents,
      'captured_delta_cents',v_capture_delta,'refunded_delta_cents',v_refund_delta,
      'chargeback_delta_cents',v_chargeback_delta,'net_delta_cents',v_net_delta,'currency',UPPER(v_new.currency));
    -- Partial-capture observations diagnose cash before a canonical purchase
    -- conversion exists. They must not add a second copy of conversion revenue.
    -- Financial totals come from immutable movements, not analytics families.
    IF p_analytics->>'event_name'='payment_captured' THEN
      v_properties:=v_properties-'revenue';
    END IF;
    INSERT INTO public.solidgate_analytics_outbox (environment,event_key,event_name,distinct_id,insert_id,properties)
    VALUES (p_environment,p_analytics->>'event_key',p_analytics->>'event_name',p_analytics->>'distinct_id',
      (p_analytics->>'insert_id')::UUID,v_properties) ON CONFLICT (environment,event_key) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('applied',TRUE,'captured_amount_cents',v_new.captured_amount_cents,
    'refunded_amount_cents',v_new.refunded_amount_cents,'chargeback_amount_cents',v_new.chargeback_amount_cents,
    'net_amount_cents',v_new.net_amount_cents,'status',v_financial_status,'payment_status',v_new.payment_status,
    'captured_delta_cents',v_capture_delta,'refunded_delta_cents',v_refund_delta,'net_delta_cents',v_net_delta);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_solidgate_financial_event(TEXT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_solidgate_financial_event(TEXT,TEXT,TEXT,JSONB,JSONB) TO service_role;

CREATE TABLE IF NOT EXISTS public.solidgate_subscription_snapshots (
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  solidgate_subscription_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  user_id UUID,
  status TEXT,
  started_at TIMESTAMPTZ,
  next_charge_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_cancelled_event_at TIMESTAMPTZ,
  trial BOOLEAN,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  period_start_at TIMESTAMPTZ,
  period_end_at TIMESTAMPTZ,
  latest_event_key TEXT NOT NULL,
  latest_event_type TEXT NOT NULL,
  latest_event_created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment,solidgate_subscription_id)
);
CREATE TABLE IF NOT EXISTS public.solidgate_subscription_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  solidgate_subscription_id TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES public.orders(id),
  user_id UUID,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_created_at TIMESTAMPTZ NOT NULL,
  facts JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment,solidgate_subscription_id,event_key)
);
CREATE INDEX IF NOT EXISTS solidgate_subscription_history_order_idx
  ON public.solidgate_subscription_history (order_id,event_created_at);
ALTER TABLE public.solidgate_subscription_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solidgate_subscription_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.solidgate_subscription_snapshots, public.solidgate_subscription_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.solidgate_subscription_snapshots TO service_role;
GRANT SELECT,INSERT ON public.solidgate_subscription_history TO service_role;
DROP TRIGGER IF EXISTS solidgate_subscription_history_immutable ON public.solidgate_subscription_history;
CREATE TRIGGER solidgate_subscription_history_immutable BEFORE UPDATE OR DELETE ON public.solidgate_subscription_history
  FOR EACH ROW EXECUTE FUNCTION public.reject_solidgate_history_mutation();

CREATE OR REPLACE FUNCTION public.record_solidgate_subscription_snapshot(
  p_environment TEXT,p_event_key TEXT,p_order_db_id UUID,p_subscription_id TEXT,
  p_event_type TEXT,p_event_created_at TIMESTAMPTZ,p_facts JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_snapshot public.solidgate_subscription_snapshots%ROWTYPE;
  v_applied BOOLEAN;
BEGIN
  IF p_environment NOT IN ('production','sandbox') OR NULLIF(p_event_key,'') IS NULL
    OR NULLIF(p_event_type,'') IS NULL OR p_event_created_at IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid subscription snapshot' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_db_id FOR UPDATE;
  IF NOT FOUND OR v_order.psp<>'solidgate' OR v_order.payment_environment<>p_environment
    OR v_order.solidgate_subscription_id IS DISTINCT FROM p_subscription_id THEN
    RAISE EXCEPTION 'subscription snapshot ownership mismatch' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.solidgate_subscription_history(environment,solidgate_subscription_id,order_id,user_id,event_key,event_type,event_created_at,facts)
    VALUES(p_environment,p_subscription_id,v_order.id,v_order.user_id,p_event_key,p_event_type,p_event_created_at,p_facts)
    ON CONFLICT DO NOTHING;
  SELECT * INTO v_snapshot FROM public.solidgate_subscription_snapshots
    WHERE environment=p_environment AND solidgate_subscription_id=p_subscription_id FOR UPDATE;
  -- Equal-time terminal events win; only a strictly newer explicit restore
  -- can clear cancellation. Ordinary active/pause observations cannot do so.
  v_applied := NOT FOUND OR p_event_created_at>v_snapshot.latest_event_created_at
    OR (p_event_created_at=v_snapshot.latest_event_created_at AND p_event_type IN ('cancel','cancelled','canceled','expire','expired'));
  IF v_applied THEN
    INSERT INTO public.solidgate_subscription_snapshots(environment,solidgate_subscription_id,order_id,user_id,status,
      started_at,next_charge_at,cancelled_at,last_cancelled_event_at,trial,trial_started_at,trial_ends_at,
      period_start_at,period_end_at,latest_event_key,latest_event_type,latest_event_created_at)
    VALUES(p_environment,p_subscription_id,v_order.id,v_order.user_id,p_facts->>'status',
      NULLIF(p_facts->>'started_at','')::TIMESTAMPTZ,NULLIF(p_facts->>'next_charge_at','')::TIMESTAMPTZ,
      NULLIF(p_facts->>'cancelled_at','')::TIMESTAMPTZ,
      CASE WHEN p_event_type IN ('cancel','cancelled','canceled','expire','expired') THEN p_event_created_at END,
      (p_facts->>'trial')::BOOLEAN,NULLIF(p_facts->>'trial_started_at','')::TIMESTAMPTZ,
      NULLIF(p_facts->>'trial_ends_at','')::TIMESTAMPTZ,NULLIF(p_facts->>'period_start_at','')::TIMESTAMPTZ,
      NULLIF(p_facts->>'period_end_at','')::TIMESTAMPTZ,p_event_key,p_event_type,p_event_created_at)
    ON CONFLICT(environment,solidgate_subscription_id) DO UPDATE SET
      user_id=COALESCE(EXCLUDED.user_id,solidgate_subscription_snapshots.user_id),status=COALESCE(EXCLUDED.status,solidgate_subscription_snapshots.status),
      started_at=COALESCE(solidgate_subscription_snapshots.started_at,EXCLUDED.started_at),
      next_charge_at=EXCLUDED.next_charge_at,
      cancelled_at=CASE WHEN p_event_type='restore' THEN NULL ELSE COALESCE(EXCLUDED.cancelled_at,solidgate_subscription_snapshots.cancelled_at) END,
      last_cancelled_event_at=GREATEST(EXCLUDED.last_cancelled_event_at,solidgate_subscription_snapshots.last_cancelled_event_at),
      trial=COALESCE(EXCLUDED.trial,solidgate_subscription_snapshots.trial),
      trial_started_at=COALESCE(solidgate_subscription_snapshots.trial_started_at,EXCLUDED.trial_started_at),
      trial_ends_at=COALESCE(EXCLUDED.trial_ends_at,solidgate_subscription_snapshots.trial_ends_at),
      period_start_at=COALESCE(EXCLUDED.period_start_at,solidgate_subscription_snapshots.period_start_at),
      period_end_at=COALESCE(EXCLUDED.period_end_at,solidgate_subscription_snapshots.period_end_at),
      latest_event_key=EXCLUDED.latest_event_key,latest_event_type=EXCLUDED.latest_event_type,
      latest_event_created_at=EXCLUDED.latest_event_created_at,updated_at=NOW();
  ELSIF p_event_type IN ('cancel','cancelled','canceled','expire','expired') THEN
    UPDATE public.solidgate_subscription_snapshots SET last_cancelled_event_at=GREATEST(last_cancelled_event_at,p_event_created_at)
      WHERE environment=p_environment AND solidgate_subscription_id=p_subscription_id;
  END IF;
  RETURN jsonb_build_object('applied',v_applied,'status',p_facts->>'status');
END;
$$;
REVOKE ALL ON FUNCTION public.record_solidgate_subscription_snapshot(TEXT,TEXT,UUID,TEXT,TEXT,TIMESTAMPTZ,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_solidgate_subscription_snapshot(TEXT,TEXT,UUID,TEXT,TEXT,TIMESTAMPTZ,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.restore_solidgate_subscription_entitlement(
  p_payment_environment TEXT,p_order_db_id UUID,p_user_id UUID,p_product_slug TEXT,
  p_solidgate_subscription_id TEXT,p_access_level TEXT,p_expires_at TIMESTAMPTZ,
  p_event_key TEXT,p_event_created_at TIMESTAMPTZ
) RETURNS TEXT LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_snapshot public.solidgate_subscription_snapshots%ROWTYPE;
  v_marker TEXT;
BEGIN
  IF p_payment_environment NOT IN ('production','sandbox') OR p_event_created_at IS NULL
    OR p_expires_at IS NULL OR p_expires_at<=p_event_created_at OR p_access_level NOT IN ('full','trial') THEN RETURN 'invalid'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id=p_order_db_id FOR UPDATE;
  IF NOT FOUND OR v_order.payment_environment<>p_payment_environment OR v_order.psp<>'solidgate'
    OR v_order.user_id IS DISTINCT FROM p_user_id OR v_order.product_slug IS DISTINCT FROM p_product_slug
    OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
    OR v_order.solidgate_checkout_identity_legacy THEN RETURN 'invalid'; END IF;
  IF v_order.status IN ('refunded','disputed') OR v_order.solidgate_payment_status='void_ok'
    OR v_order.solidgate_chargeback_id IS NOT NULL OR v_order.solidgate_chargeback_status IS NOT NULL
    OR v_order.solidgate_chargeback_amount_cents>0 THEN RETURN 'reversed'; END IF;
  SELECT * INTO v_snapshot FROM public.solidgate_subscription_snapshots
    WHERE environment=p_payment_environment AND solidgate_subscription_id=p_solidgate_subscription_id FOR UPDATE;
  IF NOT FOUND OR v_snapshot.latest_event_key IS DISTINCT FROM p_event_key OR v_snapshot.latest_event_type<>'restore'
    OR v_snapshot.latest_event_created_at<>p_event_created_at
    OR (v_snapshot.last_cancelled_event_at IS NOT NULL AND p_event_created_at<=v_snapshot.last_cancelled_event_at) THEN RETURN 'stale'; END IF;
  SELECT * INTO v_entitlement FROM public.entitlements
    WHERE payment_environment=p_payment_environment AND user_id=p_user_id AND product_slug=p_product_slug FOR UPDATE;
  IF NOT FOUND OR v_entitlement.order_id IS DISTINCT FROM p_order_db_id
    OR v_entitlement.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id THEN RETURN 'invalid'; END IF;
  IF (v_entitlement.revoked_at IS NOT NULL OR v_entitlement.status='canceled')
    AND (v_snapshot.last_cancelled_event_at IS NULL OR v_order.status<>'canceled') THEN RETURN 'lifecycle_owned'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.solidgate_payment_balances
      WHERE environment=p_payment_environment AND order_id=p_order_db_id
        AND solidgate_subscription_id=p_solidgate_subscription_id AND captured_amount_cents>0
        AND net_amount_cents>0 AND chargeback_id IS NULL AND chargeback_status IS NULL
        AND period_end_at>=p_expires_at AND NOT needs_reconciliation) THEN RETURN 'unpaid'; END IF;
  -- Any reversed evidence for the same paid period takes priority over a
  -- second positive attempt. A newer paid period is evaluated independently.
  IF EXISTS (SELECT 1 FROM public.solidgate_payment_balances
      WHERE environment=p_payment_environment AND order_id=p_order_db_id AND period_end_at>=p_expires_at
        AND (chargeback_amount_cents>0 OR (refunded_amount_cents>0 AND net_amount_cents=0))) THEN RETURN 'reversed'; END IF;
  UPDATE public.orders SET status=CASE WHEN p_access_level='trial' THEN 'trialing' ELSE 'active' END WHERE id=p_order_db_id;
  v_marker:=pg_catalog.current_setting('app.solidgate_restore_order',TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_restore_order',p_order_db_id::TEXT,TRUE);
  UPDATE public.entitlements SET status='active',access_level=p_access_level,expires_at=p_expires_at,
    revoked_at=NULL,source='solidgate_restore',updated_at=NOW() WHERE id=v_entitlement.id;
  PERFORM pg_catalog.set_config('app.solidgate_restore_order',COALESCE(v_marker,''),TRUE);
  RETURN 'applied';
END;
$$;
REVOKE ALL ON FUNCTION public.restore_solidgate_subscription_entitlement(TEXT,UUID,UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.restore_solidgate_subscription_entitlement(TEXT,UUID,UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.list_due_solidgate_card_update_attempts(
  p_payment_environment TEXT,p_limit INTEGER DEFAULT 10
) RETURNS TABLE(user_id UUID,solidgate_order_id TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  WITH candidates AS (
    SELECT attempt.id FROM public.solidgate_card_update_attempts AS attempt
    WHERE attempt.payment_environment=p_payment_environment AND attempt.is_current
      AND attempt.state IN ('issued','applying') AND attempt.created_at>NOW()-INTERVAL '48 hours'
      AND attempt.updated_at<NOW()-INTERVAL '30 seconds'
      AND (attempt.apply_started_at IS NULL OR attempt.apply_started_at<NOW()-INTERVAL '30 seconds')
    ORDER BY attempt.updated_at,attempt.id FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit,10),1),100)
  )
  UPDATE public.solidgate_card_update_attempts AS attempt SET updated_at=NOW()
  FROM candidates WHERE attempt.id=candidates.id RETURNING attempt.user_id,attempt.solidgate_order_id;
$$;
REVOKE ALL ON FUNCTION public.list_due_solidgate_card_update_attempts(TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_solidgate_card_update_attempts(TEXT,INTEGER) TO service_role;


CREATE OR REPLACE FUNCTION public.prevent_solidgate_entitlement_replay()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payment_order public.orders%ROWTYPE;
  v_old_special_free BOOLEAN := FALSE;
  v_new_special_free_provenance BOOLEAN := FALSE;
  v_payment_order_special_free BOOLEAN := FALSE;
  v_established_special_free BOOLEAN := FALSE;
BEGIN
  -- Determine special_free provenance by either the order pointer or the
  -- provider subscription.  The latter is essential when an unsafe historic
  -- writer has already detached/rebound order_id.
  --
  -- Only the ZERO-AUTH generation (payment_action auth_0_amount) counts as
  -- special_free here: since 2026-07-29 the tier settles a €1 intro and is an
  -- ordinary paid purchase, indistinguishable in risk from special_1eur.
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.orders AS candidate
      WHERE candidate.psp = 'solidgate'
        AND candidate.tracking_metadata ->> 'funnel_code' = 'BRAND'
        AND candidate.tracking_metadata ->> 'funnel_variant' = 'special_free'
        AND candidate.tracking_metadata ->> 'product_slug' = 'special_free'
        AND candidate.solidgate_payment_action = 'auth_0_amount'
        AND (
          candidate.id = OLD.order_id
          OR (
            candidate.payment_environment = OLD.payment_environment
            AND NULLIF(BTRIM(OLD.solidgate_subscription_id), '') IS NOT NULL
            AND candidate.solidgate_subscription_id
                  = OLD.solidgate_subscription_id
          )
        )
    ) INTO v_old_special_free;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.orders AS candidate
    WHERE candidate.psp = 'solidgate'
      AND candidate.tracking_metadata ->> 'funnel_code' = 'BRAND'
      AND candidate.tracking_metadata ->> 'funnel_variant' = 'special_free'
      AND candidate.tracking_metadata ->> 'product_slug' = 'special_free'
      AND candidate.solidgate_payment_action = 'auth_0_amount'
      AND (
        candidate.id = NEW.order_id
        OR (
          candidate.payment_environment = NEW.payment_environment
          AND NULLIF(BTRIM(NEW.solidgate_subscription_id), '') IS NOT NULL
          AND candidate.solidgate_subscription_id
                = NEW.solidgate_subscription_id
        )
      )
  ) INTO v_new_special_free_provenance;

  -- Revocation is a tombstone for this exact purchase. It may only be cleared
  -- by a new purchase whose entitlement upsert replaces order_id.
  IF TG_OP = 'UPDATE'
    AND (OLD.revoked_at IS NOT NULL OR OLD.status = 'canceled')
    AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
    AND NEW.revoked_at IS NULL
    AND NOT (
      COALESCE(pg_catalog.current_setting('app.solidgate_restore_order',TRUE),'') = NEW.order_id::TEXT
      AND NEW.source = 'solidgate_restore'
      AND EXISTS (SELECT 1 FROM public.solidgate_subscription_snapshots AS snapshot
        WHERE snapshot.environment=NEW.payment_environment
          AND snapshot.order_id=NEW.order_id
          AND snapshot.solidgate_subscription_id=NEW.solidgate_subscription_id
          AND snapshot.latest_event_type='restore'
          AND (snapshot.last_cancelled_event_at IS NULL
            OR snapshot.latest_event_created_at>snapshot.last_cancelled_event_at))
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'cannot reactivate a revoked entitlement with the same order';
  END IF;

  -- special_free provenance is sticky. Revoking/canceling access must retain
  -- its audit binding; otherwise a two-step cancel+detach could erase the
  -- information needed to reject a later unsafe reactivation.
  IF TG_OP = 'UPDATE'
     AND v_old_special_free
     AND NEW.order_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cannot detach a special_free entitlement from its verified order';
  END IF;

  IF NEW.revoked_at IS NULL
     AND NEW.status IN ('active', 'past_due')
     AND v_new_special_free_provenance
     AND NEW.order_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cannot grant detached special_free access';
  END IF;

  -- Live grants always inspect their order. An established special_free row is
  -- also inspected while revoked so cancel+rebind cannot erase provenance in
  -- one statement and reactivate through the unrelated order in a second.
  IF NEW.order_id IS NOT NULL
     AND (
       NEW.revoked_at IS NULL
       OR (TG_OP = 'UPDATE' AND v_old_special_free)
     ) THEN
    SELECT candidate.*
    INTO payment_order
    FROM public.orders AS candidate
    WHERE candidate.id = NEW.order_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'entitlement grant order does not exist';
    END IF;

    IF payment_order.payment_environment IS DISTINCT FROM NEW.payment_environment THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'entitlement and order payment environments do not match';
    END IF;

    IF NEW.revoked_at IS NULL
       AND payment_order.psp = 'solidgate' AND (
      payment_order.status IN ('canceled', 'refunded', 'disputed')
      -- `refunded` at provider level may be a partial refund. The lifecycle
      -- handler promotes orders.status to `refunded` only when net reaches 0.
      OR payment_order.solidgate_payment_status = 'void_ok'
      OR payment_order.solidgate_chargeback_id IS NOT NULL
      OR payment_order.solidgate_chargeback_status IS NOT NULL
      OR payment_order.solidgate_chargeback_amount_cents > 0
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'cannot grant entitlement for a terminal Solidgate order';
    END IF;

    v_payment_order_special_free :=
      payment_order.psp = 'solidgate'
      AND payment_order.tracking_metadata ->> 'funnel_code' = 'BRAND'
      AND payment_order.tracking_metadata ->> 'funnel_variant' = 'special_free'
      AND payment_order.tracking_metadata ->> 'product_slug' = 'special_free'
      AND payment_order.solidgate_payment_action = 'auth_0_amount';

    -- An established special_free entitlement cannot shed its provenance by
    -- rebinding to a non-Solidgate row, a paid Solidgate order, or any
    -- unrelated order. A
    -- genuine replacement special_free purchase is allowed only when that new
    -- order independently has exact reusable-card proof.
    IF TG_OP = 'UPDATE' AND v_old_special_free THEN
      IF NOT v_payment_order_special_free
         OR NEW.user_id IS DISTINCT FROM payment_order.user_id
         OR NEW.product_slug IS DISTINCT FROM payment_order.product_slug
         OR NEW.solidgate_subscription_id
              IS DISTINCT FROM payment_order.solidgate_subscription_id
         OR (
           OLD.order_id IS DISTINCT FROM NEW.order_id
           AND NOT public.solidgate_special_free_card_ready(payment_order.id)
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'cannot rebind a special_free entitlement without a new verified special_free purchase';
      END IF;
    END IF;

    IF NEW.revoked_at IS NULL
       AND NEW.status IN ('active', 'past_due')
       AND (v_payment_order_special_free OR v_new_special_free_provenance) THEN
      IF TG_OP = 'UPDATE' THEN
        v_established_special_free :=
          OLD.revoked_at IS NULL
          AND OLD.status IN ('active', 'past_due')
          AND OLD.payment_environment IS NOT DISTINCT FROM NEW.payment_environment
          AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
          AND OLD.user_id IS NOT DISTINCT FROM payment_order.user_id
          AND OLD.product_slug IS NOT DISTINCT FROM payment_order.product_slug
          AND OLD.solidgate_subscription_id
                IS NOT DISTINCT FROM payment_order.solidgate_subscription_id;
      END IF;

      IF NOT v_payment_order_special_free
         OR NEW.user_id IS DISTINCT FROM payment_order.user_id
         OR NEW.product_slug IS DISTINCT FROM payment_order.product_slug
         OR NEW.solidgate_subscription_id
              IS DISTINCT FROM payment_order.solidgate_subscription_id
         OR (
           NOT v_established_special_free
           AND NOT public.solidgate_special_free_card_ready(payment_order.id)
         ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'cannot grant special_free entitlement without exact reusable-card proof';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_solidgate_subscription_entitlement_lifecycle(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_solidgate_subscription_id TEXT,
  p_access_level TEXT,
  p_status TEXT,
  p_expires_at TIMESTAMPTZ,
  p_source TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_owner public.orders%ROWTYPE;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR NULLIF(BTRIM(COALESCE(p_product_slug, '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_solidgate_subscription_id, '')), '') IS NULL
     OR p_access_level NOT IN ('full', 'trial', 'grace')
     OR p_status NOT IN ('active', 'past_due')
     OR (p_status = 'active' AND p_expires_at IS NULL)
     OR NULLIF(BTRIM(COALESCE(p_source, '')), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate subscription lifecycle mutation'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_db_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
     OR v_order.solidgate_checkout_identity_legacy THEN
    RETURN 'invalid';
  END IF;
  IF v_order.status IN ('canceled', 'refunded', 'disputed')
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN 'reversed';
  END IF;

  IF p_status = 'active' AND EXISTS (
    SELECT 1 FROM public.solidgate_payment_balances AS balance
    WHERE balance.environment=p_payment_environment AND balance.order_id=p_order_db_id
      AND balance.solidgate_subscription_id=p_solidgate_subscription_id
      AND balance.period_end_at>=p_expires_at
      AND (balance.chargeback_amount_cents>0
        OR (balance.refunded_amount_cents>0 AND balance.net_amount_cents=0)
        OR balance.payment_status='void_ok' OR balance.needs_reconciliation)
  ) THEN RETURN 'reversed'; END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_entitlement.order_id IS DISTINCT FROM p_order_db_id
     OR v_entitlement.solidgate_subscription_id
          IS DISTINCT FROM p_solidgate_subscription_id THEN
    IF v_entitlement.order_id IS NULL THEN RETURN 'invalid'; END IF;
    SELECT owner.*
    INTO v_owner
    FROM public.orders AS owner
    WHERE owner.id = v_entitlement.order_id;
    IF FOUND AND (
      (
        v_order.product_slug = 'BRAND_000000_SUB'
        AND v_owner.created_at >= v_order.created_at
      )
      OR (
        v_order.product_slug <> 'BRAND_000000_SUB'
        AND (v_owner.created_at, v_owner.id) >= (v_order.created_at, v_order.id)
      )
    ) THEN
      RETURN 'stale';
    END IF;
    RETURN 'invalid';
  END IF;

  IF v_entitlement.status = 'canceled' OR v_entitlement.revoked_at IS NOT NULL THEN
    RETURN 'lifecycle_owned';
  END IF;

  UPDATE public.entitlements AS entitlement
  -- An older positive snapshot may arrive after a paid renewal, including at
  -- the same provider timestamp. It cannot shorten that paid period or turn
  -- full access back into a trial. Recovery from past_due deliberately takes
  -- the actual paid expiry instead: the grace deadline is not paid time.
  SET access_level = CASE
        WHEN p_status = 'active' AND entitlement.status = 'active'
          AND entitlement.access_level = 'full' AND p_access_level = 'trial'
          THEN 'full'
        ELSE p_access_level
      END,
      expires_at = CASE
        WHEN p_status = 'active' AND entitlement.status = 'active'
          THEN GREATEST(p_expires_at, entitlement.expires_at)
        ELSE COALESCE(p_expires_at, entitlement.expires_at)
      END,
      source = p_source,
      status = p_status,
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN 'applied';
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_main_entitlement(
  p_payment_environment TEXT,
  p_order_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_subscription_id TEXT,
  p_amount_cents INTEGER,
  p_fallback_expires_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_id IS NULL
     OR p_user_id IS NULL
     OR p_product_slug IS DISTINCT FROM 'BRAND_000000_SUB'
     OR NULLIF(BTRIM(p_subscription_id), '') IS NULL
     OR p_amount_cents IS NULL
     OR p_amount_cents < 0
     OR p_fallback_expires_at IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate main entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.solidgate_original_amount_cents IS DISTINCT FROM p_amount_cents
     OR NOT (
       (v_order.amount_cents = p_amount_cents AND v_order.solidgate_refunded_amount_cents = 0)
       OR EXISTS (SELECT 1 FROM public.solidgate_payment_balances AS balance
         WHERE balance.environment=p_payment_environment AND balance.solidgate_order_id=v_order.solidgate_order_id
           AND balance.captured_amount_cents=p_amount_cents AND balance.net_amount_cents>0
           AND balance.chargeback_amount_cents=0 AND NOT balance.needs_reconciliation
           AND balance.capture_evidence_source='provider'
           AND balance.net_amount_cents=v_order.amount_cents
           AND balance.refunded_amount_cents=v_order.solidgate_refunded_amount_cents)
     )
     OR v_order.status NOT IN ('completed', 'trialing', 'active')
     OR v_order.solidgate_subscription_id IS DISTINCT FROM p_subscription_id
     OR NOT (
       COALESCE(
         v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled', 'refunded'),
         FALSE
       )
       OR (
         v_order.solidgate_payment_status IS NOT DISTINCT FROM 'auth_ok'
         AND p_amount_cents = 0
       )
     )
     OR (
       -- Card-first proof applies only to the zero-auth generation; a settled
       -- €1 special_free is validated by the paid-path checks above.
       v_order.tracking_metadata ->> 'funnel_code' = 'BRAND'
       AND v_order.tracking_metadata ->> 'funnel_variant' = 'special_free'
       AND v_order.tracking_metadata ->> 'product_slug' = 'special_free'
       AND v_order.solidgate_payment_action = 'auth_0_amount'
       AND NOT public.solidgate_special_free_card_ready(v_order.id)
     )
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR v_order.solidgate_chargeback_amount_cents > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_order.user_id IS NULL THEN
    UPDATE public.orders AS candidate
    SET user_id = p_user_id,
        claimed_at = COALESCE(candidate.claimed_at, NOW())
    WHERE candidate.id = p_order_id
      AND candidate.user_id IS NULL;
  ELSIF v_order.user_id IS DISTINCT FROM p_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF FOUND THEN
    IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_id THEN
      RETURN v_entitlement.revoked_at IS NULL
        AND v_entitlement.status = 'active'
        AND v_entitlement.solidgate_subscription_id
              IS NOT DISTINCT FROM p_subscription_id;
    END IF;

    SELECT existing.created_at
    INTO v_existing_order_created_at
    FROM public.orders AS existing
    WHERE existing.id = v_entitlement.order_id;
    IF v_existing_order_created_at IS NOT NULL
       AND v_existing_order_created_at >= v_order.created_at THEN
      RETURN FALSE;
    END IF;

    UPDATE public.entitlements AS entitlement
    SET access_level = 'full',
        status = 'active',
        order_id = p_order_id,
        expires_at = p_fallback_expires_at,
        source = 'solidgate_grant',
        solidgate_subscription_id = p_subscription_id,
        revoked_at = NULL,
        updated_at = NOW()
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  INSERT INTO public.entitlements (
    payment_environment,
    user_id,
    product_slug,
    access_level,
    status,
    order_id,
    expires_at,
    source,
    solidgate_subscription_id,
    revoked_at,
    updated_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_product_slug,
    'full',
    'active',
    p_order_id,
    p_fallback_expires_at,
    'solidgate_grant',
    p_subscription_id,
    NULL,
    NOW()
  )
  ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  RETURN FOUND
    AND v_entitlement.order_id IS NOT DISTINCT FROM p_order_id
    AND v_entitlement.revoked_at IS NULL
    AND v_entitlement.status = 'active'
    AND v_entitlement.solidgate_subscription_id
          IS NOT DISTINCT FROM p_subscription_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_oto_entitlement(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_access_level TEXT,
  p_expires_at TIMESTAMPTZ,
  p_solidgate_subscription_id TEXT,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_is_recurring_addon BOOLEAN;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
  v_existing_order_id UUID;
  v_step INTEGER;
  v_internal_slug TEXT;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR public.solidgate_oto_step_from_product_slug(p_product_slug) IS NULL
     OR p_access_level NOT IN ('full', 'trial')
     OR NULLIF(BTRIM(p_source), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate OTO entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment_order.*
  INTO v_order
  FROM public.orders AS payment_order
  WHERE payment_order.id = p_order_db_id
  FOR UPDATE;

  v_step := public.solidgate_oto_step_from_product_slug(p_product_slug);
  v_internal_slug := pg_catalog.split_part(v_order.solidgate_order_id, ':', 2);
  v_is_recurring_addon := p_product_slug = 'BRANDADDON_000000_SUB';
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.session_id IS NULL
     OR v_order.solidgate_order_id IS NULL
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 1)
          IS DISTINCT FROM v_order.session_id::TEXT
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 3)
          !~ '^[1-9][0-9]{0,8}$'
     OR pg_catalog.split_part(v_order.solidgate_order_id, ':', 4) <> ''
     OR public.solidgate_oto_step_from_internal_slug(v_internal_slug)
          IS DISTINCT FROM v_step
     OR v_order.solidgate_original_amount_cents IS NULL
     OR v_order.solidgate_original_amount_cents < 0
     OR v_order.currency !~ '^[a-z]{3}$'
     OR v_order.tracking_metadata IS NULL
     OR jsonb_typeof(v_order.tracking_metadata) <> 'object'
     OR v_order.tracking_metadata ->> 'session_id'
          IS DISTINCT FROM v_order.session_id::TEXT
     OR v_order.tracking_metadata ->> 'product_slug' IS DISTINCT FROM v_internal_slug
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'BRAND'
     OR v_order.tracking_metadata ->> 'funnel_variant'
          IS DISTINCT FROM ('oto' || v_step::TEXT)
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_checkout_identity_bound_at IS NULL
     OR NULLIF(BTRIM(v_order.solidgate_customer_email), '') IS NULL
     OR NULLIF(BTRIM(v_order.solidgate_checkout_locale), '') IS NULL
     OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
     OR (
       v_is_recurring_addon
       AND (
         NULLIF(BTRIM(v_order.solidgate_product_id), '') IS NULL
         OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
         OR v_order.tracking_metadata ? 'locale'
       )
     )
     OR (
       NOT v_is_recurring_addon
       AND (
         v_order.solidgate_product_id IS NOT NULL
         OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'locale'), '') IS NULL
         OR v_order.tracking_metadata ->> 'locale'
              IS DISTINCT FROM v_order.solidgate_checkout_locale
         OR v_order.tracking_metadata ? 'price_id'
       )
     )
     -- The local net must still equal the immutable provider gross. This
     -- rejects under-capture and every partial/full refund before access can be
     -- bootstrapped by a late browser response.
     OR NOT (
       (v_order.amount_cents = v_order.solidgate_original_amount_cents AND v_order.solidgate_refunded_amount_cents = 0)
       OR EXISTS (SELECT 1 FROM public.solidgate_payment_balances AS balance
         WHERE balance.environment=p_payment_environment AND balance.solidgate_order_id=v_order.solidgate_order_id
           AND balance.captured_amount_cents=v_order.solidgate_original_amount_cents AND balance.net_amount_cents>0
           AND balance.chargeback_amount_cents=0 AND NOT balance.needs_reconciliation
           AND balance.capture_evidence_source='provider'
           AND balance.net_amount_cents=v_order.amount_cents
           AND balance.refunded_amount_cents=v_order.solidgate_refunded_amount_cents)
     )
     OR v_order.solidgate_payment_status = 'void_ok'
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_is_recurring_addon THEN
    -- The €1 intro generation settles a positive per-currency gross; only the
    -- retired zero-auth generation is rejected here. The exact amount was
    -- already bound to the immutably seeded order by the settle callback.
    IF v_order.solidgate_original_amount_cents <= 0
       OR v_order.status NOT IN ('trialing', 'active')
       OR v_order.solidgate_payment_status
            NOT IN ('auth_ok', 'settle_ok', 'partial_settled', 'refunded')
       OR NULLIF(BTRIM(p_solidgate_subscription_id), '') IS NULL
       OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
       OR p_access_level IS DISTINCT FROM 'trial'
       OR p_expires_at IS NULL THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF v_order.status IS DISTINCT FROM 'completed'
       OR v_order.solidgate_payment_status NOT IN ('settle_ok', 'partial_settled', 'refunded')
       OR v_order.solidgate_subscription_id IS NOT NULL
       OR p_solidgate_subscription_id IS NOT NULL
       OR p_access_level IS DISTINCT FROM 'full'
       OR p_expires_at IS NOT NULL THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF v_order.user_id IS NULL THEN
    UPDATE public.orders AS candidate
    SET user_id = p_user_id,
        claimed_at = COALESCE(candidate.claimed_at, NOW())
    WHERE candidate.id = p_order_db_id
      AND candidate.user_id IS NULL;
  ELSIF v_order.user_id IS DISTINCT FROM p_user_id THEN
    RETURN FALSE;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.entitlements (
      payment_environment,
      user_id,
      product_slug,
      access_level,
      order_id,
      expires_at,
      source,
      solidgate_subscription_id,
      status,
      revoked_at,
      updated_at
    ) VALUES (
      p_payment_environment,
      p_user_id,
      p_product_slug,
      p_access_level,
      p_order_db_id,
      p_expires_at,
      p_source,
      p_solidgate_subscription_id,
      'active',
      NULL,
      NOW()
    )
    ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NOT NULL THEN
      RETURN TRUE;
    END IF;

    -- A webhook can win the unique-index race after our first SELECT. This
    -- command gets a fresh snapshot after waiting for that transaction.
    SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.payment_environment = p_payment_environment
      AND entitlement.user_id = p_user_id
      AND entitlement.product_slug = p_product_slug
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN FALSE;
    END IF;
  END IF;

  IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_db_id THEN
    -- A same-order webhook/grant replay never resets canceled/past-due state or
    -- overwrites an authoritative next_charge_at. It may only fill fields that
    -- an interrupted first writer left NULL.
    IF v_entitlement.status IS DISTINCT FROM 'active'
       OR v_entitlement.revoked_at IS NOT NULL
       OR v_entitlement.access_level IS DISTINCT FROM p_access_level
       OR (
         v_entitlement.solidgate_subscription_id IS NOT NULL
         AND v_entitlement.solidgate_subscription_id
               IS DISTINCT FROM p_solidgate_subscription_id
       ) THEN
      RETURN FALSE;
    END IF;

    UPDATE public.entitlements AS entitlement
    SET expires_at = COALESCE(entitlement.expires_at, p_expires_at),
        source = COALESCE(entitlement.source, p_source),
        solidgate_subscription_id = COALESCE(
          entitlement.solidgate_subscription_id,
          p_solidgate_subscription_id
        ),
        updated_at = CASE
          WHEN (entitlement.expires_at IS NULL AND p_expires_at IS NOT NULL)
            OR entitlement.source IS NULL
            OR (
              entitlement.solidgate_subscription_id IS NULL
              AND p_solidgate_subscription_id IS NOT NULL
            )
          THEN NOW()
          ELSE entitlement.updated_at
        END
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  -- A genuinely newer repurchase may replace an older entitlement. A late
  -- response from an older order can never clobber a newer PWA/session grant.
  IF v_entitlement.order_id IS NULL THEN
    RETURN FALSE;
  END IF;
  SELECT existing.created_at, existing.id
  INTO v_existing_order_created_at, v_existing_order_id
  FROM public.orders AS existing
  WHERE existing.id = v_entitlement.order_id;
  IF NOT FOUND OR (
    v_existing_order_created_at,
    v_existing_order_id
  ) >= (
    v_order.created_at,
    v_order.id
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.entitlements AS entitlement
  SET access_level = p_access_level,
      order_id = p_order_db_id,
      expires_at = p_expires_at,
      source = p_source,
      solidgate_subscription_id = p_solidgate_subscription_id,
      status = 'active',
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_solidgate_pwa_entitlement(
  p_payment_environment TEXT,
  p_order_db_id UUID,
  p_user_id UUID,
  p_product_slug TEXT,
  p_access_level TEXT,
  p_expires_at TIMESTAMPTZ,
  p_solidgate_subscription_id TEXT,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_entitlement public.entitlements%ROWTYPE;
  v_is_subscription BOOLEAN;
  v_inserted_id UUID;
  v_existing_order_created_at TIMESTAMPTZ;
  v_existing_order_id UUID;
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_order_db_id IS NULL
     OR p_user_id IS NULL
     OR NULLIF(BTRIM(p_product_slug), '') IS NULL
     OR p_access_level IS DISTINCT FROM 'full'
     OR NULLIF(BTRIM(p_source), '') IS NULL THEN
    RAISE EXCEPTION 'invalid Solidgate PWA entitlement grant'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment_order.*
  INTO v_order
  FROM public.orders AS payment_order
  WHERE payment_order.id = p_order_db_id
  FOR UPDATE;

  v_is_subscription := p_product_slug = 'BRANDADDON_000000_SUB';
  IF NOT FOUND
     OR v_order.psp IS DISTINCT FROM 'solidgate'
     OR v_order.payment_environment IS DISTINCT FROM p_payment_environment
     OR v_order.user_id IS DISTINCT FROM p_user_id
     OR v_order.session_id IS NOT NULL
     OR v_order.product_slug IS DISTINCT FROM p_product_slug
     OR v_order.product_name IS DISTINCT FROM p_product_slug
     OR v_order.tracking_metadata ->> 'funnel_code' IS DISTINCT FROM 'PWA'
     OR v_order.tracking_metadata ->> 'funnel_variant' IS DISTINCT FROM 'member_area'
     OR v_order.solidgate_checkout_identity_legacy
     OR v_order.solidgate_original_amount_cents IS NULL
     OR v_order.solidgate_original_amount_cents <= 0
     OR NOT (
       (v_order.amount_cents = v_order.solidgate_original_amount_cents AND v_order.solidgate_refunded_amount_cents = 0)
       OR EXISTS (SELECT 1 FROM public.solidgate_payment_balances AS balance
         WHERE balance.environment=p_payment_environment AND balance.solidgate_order_id=v_order.solidgate_order_id
           AND balance.captured_amount_cents=v_order.solidgate_original_amount_cents AND balance.net_amount_cents>0
           AND balance.chargeback_amount_cents=0 AND NOT balance.needs_reconciliation
           AND balance.capture_evidence_source='provider'
           AND balance.net_amount_cents=v_order.amount_cents
           AND balance.refunded_amount_cents=v_order.solidgate_refunded_amount_cents)
     )
     OR v_order.solidgate_payment_status NOT IN ('settle_ok', 'partial_settled', 'refunded')
     OR v_order.solidgate_chargeback_id IS NOT NULL
     OR v_order.solidgate_chargeback_status IS NOT NULL
     OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
    RETURN FALSE;
  END IF;

  IF v_is_subscription THEN
    IF v_order.status IS DISTINCT FROM 'active'
       OR NULLIF(BTRIM(v_order.solidgate_product_id), '') IS NULL
       OR NULLIF(BTRIM(v_order.tracking_metadata ->> 'price_id'), '') IS NULL
       OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
       OR NULLIF(BTRIM(p_solidgate_subscription_id), '') IS NULL
       OR v_order.solidgate_subscription_id IS DISTINCT FROM p_solidgate_subscription_id
       OR p_expires_at IS NULL THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF v_order.status IS DISTINCT FROM 'completed'
       OR v_order.solidgate_product_id IS NOT NULL
       OR v_order.solidgate_payment_action IS DISTINCT FROM 'auth_settle'
       OR v_order.solidgate_subscription_id IS NOT NULL
       OR p_solidgate_subscription_id IS NOT NULL
       OR p_expires_at IS NOT NULL THEN
      RETURN FALSE;
    END IF;
  END IF;

  SELECT entitlement.*
  INTO v_entitlement
  FROM public.entitlements AS entitlement
  WHERE entitlement.payment_environment = p_payment_environment
    AND entitlement.user_id = p_user_id
    AND entitlement.product_slug = p_product_slug
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.entitlements (
      payment_environment, user_id, product_slug, access_level, order_id,
      expires_at, source, solidgate_subscription_id,
      status, revoked_at, updated_at
    ) VALUES (
      p_payment_environment, p_user_id, p_product_slug, p_access_level,
      p_order_db_id, p_expires_at, p_source,
      p_solidgate_subscription_id, 'active', NULL, NOW()
    )
    ON CONFLICT (payment_environment, user_id, product_slug) DO NOTHING
    RETURNING id INTO v_inserted_id;
    IF v_inserted_id IS NOT NULL THEN RETURN TRUE; END IF;

    SELECT entitlement.*
    INTO v_entitlement
    FROM public.entitlements AS entitlement
    WHERE entitlement.payment_environment = p_payment_environment
      AND entitlement.user_id = p_user_id
      AND entitlement.product_slug = p_product_slug
    FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
  END IF;

  IF v_entitlement.order_id IS NOT DISTINCT FROM p_order_db_id THEN
    IF v_entitlement.status IS DISTINCT FROM 'active'
       OR v_entitlement.revoked_at IS NOT NULL
       OR (
         v_entitlement.solidgate_subscription_id IS NOT NULL
         AND v_entitlement.solidgate_subscription_id
               IS DISTINCT FROM p_solidgate_subscription_id
       ) THEN
      RETURN FALSE;
    END IF;
    UPDATE public.entitlements AS entitlement
    SET expires_at = COALESCE(entitlement.expires_at, p_expires_at),
        source = COALESCE(entitlement.source, p_source),
        solidgate_subscription_id = COALESCE(
          entitlement.solidgate_subscription_id,
          p_solidgate_subscription_id
        ),
        updated_at = CASE
          WHEN (entitlement.expires_at IS NULL AND p_expires_at IS NOT NULL)
            OR entitlement.source IS NULL
            OR (
              entitlement.solidgate_subscription_id IS NULL
              AND p_solidgate_subscription_id IS NOT NULL
            )
          THEN NOW()
          ELSE entitlement.updated_at
        END
    WHERE entitlement.id = v_entitlement.id;
    RETURN TRUE;
  END IF;

  IF v_entitlement.order_id IS NULL THEN RETURN FALSE; END IF;
  SELECT existing.created_at, existing.id
  INTO v_existing_order_created_at, v_existing_order_id
  FROM public.orders AS existing
  WHERE existing.id = v_entitlement.order_id;
  IF NOT FOUND OR (
    v_existing_order_created_at,
    v_existing_order_id
  ) >= (
    v_order.created_at,
    v_order.id
  ) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.entitlements AS entitlement
  SET access_level = p_access_level,
      order_id = p_order_db_id,
      expires_at = p_expires_at,
      source = p_source,
      solidgate_subscription_id = p_solidgate_subscription_id,
      status = 'active',
      revoked_at = NULL,
      updated_at = NOW()
  WHERE entitlement.id = v_entitlement.id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.open_solidgate_pwa_purchase_v2(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_offer_slug TEXT,
  p_product_slug TEXT,
  p_amount_cents INTEGER,
  p_currency TEXT,
  p_tracking_metadata JSONB,
  p_requested_mode TEXT,
  p_claim_token UUID,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_solidgate_product_id TEXT,
  p_solidgate_payment_action TEXT
)
RETURNS TABLE (
  order_db_id UUID,
  solidgate_order_id TEXT,
  bound_payment_environment TEXT,
  bound_user_id UUID,
  bound_offer_slug TEXT,
  bound_product_slug TEXT,
  bound_product_name TEXT,
  bound_amount_cents INTEGER,
  bound_currency TEXT,
  bound_order_status TEXT,
  bound_payment_status TEXT,
  bound_tracking_metadata JSONB,
  purchase_mode TEXT,
  solidgate_subscription_id TEXT,
  verify_url TEXT,
  last_result_kind TEXT,
  last_result_net_amount_cents INTEGER,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  bound_solidgate_product_id TEXT,
  bound_solidgate_payment_action TEXT,
  is_new BOOLEAN,
  should_build BOOLEAN,
  should_submit BOOLEAN,
  needs_reconcile BOOLEAN,
  claim_token UUID,
  merchant_data JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opened RECORD;
  v_identity public.orders%ROWTYPE;
  v_existing_order public.orders%ROWTYPE;
  v_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_state_found BOOLEAN := FALSE;
  v_is_retired BOOLEAN := FALSE;
  v_should_build BOOLEAN := FALSE;
  v_should_submit BOOLEAN := FALSE;
  v_needs_reconcile BOOLEAN := FALSE;
  v_return_claim UUID;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_customer_email, '')));
  v_locale TEXT := BTRIM(COALESCE(p_checkout_locale, ''));
  v_product_id TEXT := NULLIF(BTRIM(COALESCE(p_solidgate_product_id, '')), '');
  v_payment_action TEXT := BTRIM(COALESCE(p_solidgate_payment_action, ''));
BEGIN
  IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate PWA checkout identity'
      USING ERRCODE = '22023';
  END IF;
  IF (
       NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NOT NULL
       AND v_product_id IS NULL
     ) OR (
       NULLIF(BTRIM(p_tracking_metadata ->> 'price_id'), '') IS NULL
       AND v_product_id IS NOT NULL
     ) OR (
       v_product_id IS NOT NULL
       AND (
         CHAR_LENGTH(v_product_id) > 255
         OR v_product_id !~ '^[[:alnum:]_-]+$'
       )
     ) THEN
    RAISE EXCEPTION 'invalid Solidgate PWA provider product identity'
      USING ERRCODE = '22023';
  END IF;
  IF v_payment_action IS DISTINCT FROM 'auth_settle' THEN
    RAISE EXCEPTION 'invalid Solidgate PWA payment action'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', v_email, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', v_locale, TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', COALESCE(v_product_id, ''), TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', v_payment_action, TRUE);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate:pwa:' || p_payment_environment || ':' ||
      p_user_id::TEXT || ':' || p_product_slug,
      0
    )
  );
  SELECT state.*
  INTO v_state
  FROM public.solidgate_pwa_purchase_states AS state
  WHERE state.payment_environment = p_payment_environment
    AND state.user_id = p_user_id
    AND state.product_slug = p_product_slug
  FOR UPDATE;
  v_state_found := FOUND;

  IF v_state_found THEN
    SELECT candidate.*
    INTO STRICT v_existing_order
    FROM public.orders AS candidate
    WHERE candidate.id = v_state.order_db_id
    FOR UPDATE;
    v_is_retired := v_existing_order.status IN ('canceled', 'expired', 'refunded')
      OR (
        v_existing_order.status = 'failed'
        AND v_existing_order.amount_cents = 0
        AND COALESCE(
              v_existing_order.solidgate_original_amount_cents,
              v_existing_order.amount_cents
            ) > 0
        AND v_existing_order.solidgate_payment_status IN (
          'auth_failed', 'declined', 'void_ok', 'request_rejected'
        )
      );
  END IF;

  IF p_offer_slug = 'oto2_addon_weekly' AND EXISTS (
    SELECT 1 FROM public.orders AS existing
    WHERE existing.payment_environment=p_payment_environment AND existing.user_id=p_user_id
      AND existing.psp='solidgate' AND existing.product_slug=p_product_slug
      AND existing.solidgate_subscription_id IS NOT NULL
      AND existing.status IN ('completed','trialing','active','past_due')
      AND (NOT v_state_found OR v_is_retired OR existing.id<>v_state.order_db_id)
  ) THEN
    RAISE EXCEPTION 'subscription_recovery_required' USING ERRCODE='23514';
  END IF;

  IF v_state_found AND NOT v_is_retired THEN
    IF v_state.offer_slug IS DISTINCT FROM p_offer_slug
       OR v_state.purchase_mode IS DISTINCT FROM p_requested_mode
       OR v_existing_order.payment_environment IS DISTINCT FROM p_payment_environment
       OR v_existing_order.user_id IS DISTINCT FROM p_user_id
       OR v_existing_order.session_id IS NOT NULL
       OR v_existing_order.psp IS DISTINCT FROM 'solidgate'
       OR v_existing_order.product_slug IS DISTINCT FROM p_product_slug
       OR v_existing_order.product_name IS DISTINCT FROM p_product_slug
       OR COALESCE(
            v_existing_order.solidgate_original_amount_cents,
            v_existing_order.amount_cents
          ) IS DISTINCT FROM p_amount_cents
       OR LOWER(v_existing_order.currency) IS DISTINCT FROM p_currency
       OR v_existing_order.tracking_metadata IS DISTINCT FROM p_tracking_metadata
       OR v_existing_order.solidgate_customer_email IS DISTINCT FROM v_email
       OR v_existing_order.solidgate_checkout_locale IS DISTINCT FROM v_locale
       OR v_existing_order.solidgate_product_id IS DISTINCT FROM v_product_id
       OR v_existing_order.solidgate_payment_action IS DISTINCT FROM v_payment_action
       OR v_existing_order.solidgate_checkout_identity_legacy THEN
      RAISE EXCEPTION 'existing Solidgate PWA purchase snapshot mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF p_requested_mode = 'saved_card'
       AND v_existing_order.status = 'failed'
       AND v_existing_order.amount_cents = p_amount_cents
       AND (
         v_existing_order.solidgate_payment_status IS NULL
         OR v_existing_order.solidgate_payment_status = 'creating'
       ) THEN
      UPDATE public.orders AS candidate
      SET status = 'pending',
          solidgate_payment_status = 'creating',
          solidgate_submission_token = p_claim_token,
          solidgate_submission_started_at = NOW()
      WHERE candidate.id = v_existing_order.id
      RETURNING candidate.* INTO v_existing_order;
      UPDATE public.solidgate_pwa_purchase_states AS state
      SET claim_token = p_claim_token,
          claim_kind = 'reconcile',
          claim_started_at = NOW(),
          updated_at = NOW()
      WHERE state.payment_environment = p_payment_environment
        AND state.user_id = p_user_id
        AND state.product_slug = p_product_slug
      RETURNING state.* INTO v_state;
      v_needs_reconcile := TRUE;
      v_return_claim := p_claim_token;
    ELSE
      IF v_existing_order.solidgate_payment_status IS NOT NULL
         AND v_existing_order.solidgate_payment_status <> 'creating'
         AND v_state.claim_kind IS NOT NULL THEN
        UPDATE public.solidgate_pwa_purchase_states AS state
        SET claim_kind = NULL,
            claim_started_at = NULL,
            updated_at = NOW()
        WHERE state.payment_environment = p_payment_environment
          AND state.user_id = p_user_id
          AND state.product_slug = p_product_slug
        RETURNING state.* INTO v_state;
      END IF;

      IF v_existing_order.status = 'pending'
         AND (
           v_existing_order.solidgate_payment_status IS NULL
           OR v_existing_order.solidgate_payment_status = 'creating'
         ) THEN
        IF p_requested_mode = 'hosted_form'
           AND v_state.merchant_data IS NULL
           AND (
             (v_state.claim_kind = 'build_form' AND v_state.claim_token = p_claim_token)
             OR v_state.claim_kind IS NULL
             OR v_state.claim_started_at < NOW() - INTERVAL '30 seconds'
           ) THEN
          UPDATE public.solidgate_pwa_purchase_states AS state
          SET claim_token = p_claim_token,
              claim_kind = 'build_form',
              claim_started_at = NOW(),
              updated_at = NOW()
          WHERE state.payment_environment = p_payment_environment
            AND state.user_id = p_user_id
            AND state.product_slug = p_product_slug
          RETURNING state.* INTO v_state;
          UPDATE public.orders AS candidate
          SET solidgate_submission_token = p_claim_token,
              solidgate_submission_started_at = NOW()
          WHERE candidate.id = v_existing_order.id;
          v_should_build := TRUE;
          v_return_claim := p_claim_token;
        ELSIF p_requested_mode = 'saved_card'
              AND (
                v_state.claim_kind IS NULL
                OR v_state.claim_started_at < NOW() - INTERVAL '120 seconds'
              ) THEN
          UPDATE public.solidgate_pwa_purchase_states AS state
          SET claim_token = p_claim_token,
              claim_kind = 'reconcile',
              claim_started_at = NOW(),
              updated_at = NOW()
          WHERE state.payment_environment = p_payment_environment
            AND state.user_id = p_user_id
            AND state.product_slug = p_product_slug
          RETURNING state.* INTO v_state;
          UPDATE public.orders AS candidate
          SET solidgate_submission_token = p_claim_token,
              solidgate_submission_started_at = NOW()
          WHERE candidate.id = v_existing_order.id;
          v_needs_reconcile := TRUE;
          v_return_claim := p_claim_token;
        END IF;
      END IF;
    END IF;

    SELECT
      v_existing_order.id AS order_db_id,
      v_existing_order.solidgate_order_id AS solidgate_order_id,
      v_existing_order.payment_environment AS bound_payment_environment,
      v_existing_order.user_id AS bound_user_id,
      v_state.offer_slug AS bound_offer_slug,
      v_existing_order.product_slug AS bound_product_slug,
      v_existing_order.product_name AS bound_product_name,
      COALESCE(
        v_existing_order.solidgate_original_amount_cents,
        v_existing_order.amount_cents
      ) AS bound_amount_cents,
      LOWER(v_existing_order.currency) AS bound_currency,
      v_existing_order.status AS bound_order_status,
      v_existing_order.solidgate_payment_status AS bound_payment_status,
      v_existing_order.tracking_metadata AS bound_tracking_metadata,
      v_state.purchase_mode AS purchase_mode,
      v_existing_order.solidgate_subscription_id AS solidgate_subscription_id,
      v_existing_order.solidgate_verify_url AS verify_url,
      v_state.last_result_kind AS last_result_kind,
      v_state.last_result_net_amount_cents AS last_result_net_amount_cents,
      FALSE AS is_new,
      v_should_build AS should_build,
      v_should_submit AS should_submit,
      v_needs_reconcile AS needs_reconcile,
      v_return_claim AS claim_token,
      v_state.merchant_data AS merchant_data
    INTO STRICT v_opened;
  ELSE
    SELECT opened.*
    INTO STRICT v_opened
    FROM public.open_solidgate_pwa_purchase(
      p_payment_environment,
      p_user_id,
      p_offer_slug,
      p_product_slug,
      p_amount_cents,
      p_currency,
      p_tracking_metadata,
      p_requested_mode,
      p_claim_token
    ) AS opened;
  END IF;

  SELECT candidate.*
  INTO STRICT v_identity
  FROM public.orders AS candidate
  WHERE candidate.id = v_opened.order_db_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.solidgate_order_id = v_opened.solidgate_order_id
    AND candidate.user_id = p_user_id
    AND candidate.session_id IS NULL
    AND candidate.psp = 'solidgate'
  FOR SHARE;

  IF v_identity.solidgate_checkout_identity_legacy
     OR v_identity.solidgate_customer_email IS NULL
     OR v_identity.solidgate_checkout_locale IS NULL
     OR v_identity.solidgate_checkout_identity_bound_at IS NULL THEN
    RAISE EXCEPTION 'legacy Solidgate PWA checkout identity requires provider reconciliation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_catalog.set_config('app.solidgate_customer_email', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_checkout_locale', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_product_id', '', TRUE);
  PERFORM pg_catalog.set_config('app.solidgate_payment_action', '', TRUE);

  RETURN QUERY SELECT
    v_opened.order_db_id::UUID,
    v_opened.solidgate_order_id::TEXT,
    v_opened.bound_payment_environment::TEXT,
    v_opened.bound_user_id::UUID,
    v_opened.bound_offer_slug::TEXT,
    v_opened.bound_product_slug::TEXT,
    v_opened.bound_product_name::TEXT,
    v_opened.bound_amount_cents::INTEGER,
    v_opened.bound_currency::TEXT,
    v_opened.bound_order_status::TEXT,
    v_opened.bound_payment_status::TEXT,
    v_opened.bound_tracking_metadata::JSONB,
    v_opened.purchase_mode::TEXT,
    v_opened.solidgate_subscription_id::TEXT,
    v_opened.verify_url::TEXT,
    v_opened.last_result_kind::TEXT,
    v_opened.last_result_net_amount_cents::INTEGER,
    v_identity.solidgate_customer_email,
    v_identity.solidgate_checkout_locale,
    v_identity.solidgate_product_id,
    v_identity.solidgate_payment_action,
    v_opened.is_new::BOOLEAN,
    v_opened.should_build::BOOLEAN,
    v_opened.should_submit::BOOLEAN,
    v_opened.needs_reconcile::BOOLEAN,
    v_opened.claim_token::UUID,
    v_opened.merchant_data::JSONB;
END;
$$;

-- Preserve existing reporting as an explicitly estimated opening balance. No
-- historic order/renewal is changed here and these rows are NOT promoted to
-- provider transaction proof. A later verified capture replaces this estimate.
INSERT INTO public.solidgate_payment_balances (
  environment,solidgate_order_id,order_id,user_id,solidgate_subscription_id,product_key,currency,
  quoted_amount_cents,captured_amount_cents,refunded_amount_cents,chargeback_id,chargeback_status,
  chargeback_amount_cents,chargeback_occurred_at,net_amount_cents,payment_status,first_captured_at,
  first_captured_at_source,capture_evidence_source,needs_reconciliation
)
SELECT payment_environment,solidgate_order_id,id,user_id,solidgate_subscription_id,product_slug,LOWER(currency),
  solidgate_original_amount_cents,
  COALESCE(solidgate_original_amount_cents,GREATEST(0,amount_cents)+GREATEST(solidgate_refunded_amount_cents,solidgate_chargeback_amount_cents)),
  solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,
  CASE WHEN solidgate_chargeback_status IN ('reversed','resolved_reversal') THEN 0 ELSE solidgate_chargeback_amount_cents END,
  CASE WHEN solidgate_chargeback_status IS NOT NULL THEN updated_at END,
  GREATEST(0,COALESCE(solidgate_original_amount_cents,GREATEST(0,amount_cents)+GREATEST(solidgate_refunded_amount_cents,solidgate_chargeback_amount_cents))
    -GREATEST(solidgate_refunded_amount_cents,CASE WHEN solidgate_chargeback_status IN ('reversed','resolved_reversal') THEN 0 ELSE solidgate_chargeback_amount_cents END)),
  solidgate_payment_status,created_at,'legacy_observation','legacy_projection',TRUE
FROM public.orders
WHERE psp='solidgate' AND solidgate_order_id IS NOT NULL
  AND (solidgate_payment_status IN ('settle_ok','partial_settled','refunded')
    OR status IN ('completed','trialing','active','past_due','canceled','refunded','disputed'))
ON CONFLICT DO NOTHING;
INSERT INTO public.solidgate_payment_balances (
  environment,solidgate_order_id,order_id,user_id,solidgate_invoice_id,solidgate_subscription_id,
  subscription_term_number,product_key,currency,quoted_amount_cents,captured_amount_cents,refunded_amount_cents,
  chargeback_id,chargeback_status,chargeback_amount_cents,chargeback_occurred_at,net_amount_cents,
  payment_status,first_captured_at,first_captured_at_source,capture_evidence_source,invoice_created_at,needs_reconciliation
)
SELECT renewal.payment_environment,renewal.solidgate_order_id,parent.id,parent.user_id,renewal.solidgate_invoice_id,
  renewal.solidgate_subscription_id,renewal.subscription_term_number,renewal.product_key,LOWER(renewal.currency),
  renewal.gross_amount_cents,COALESCE(renewal.gross_amount_cents,renewal.amount_cents+GREATEST(renewal.refunded_amount_cents,renewal.chargeback_amount_cents)),
  renewal.refunded_amount_cents,renewal.chargeback_id,renewal.chargeback_status,
  CASE WHEN renewal.chargeback_status IN ('reversed','resolved_reversal') THEN 0 ELSE renewal.chargeback_amount_cents END,
  CASE WHEN renewal.chargeback_status IS NOT NULL THEN COALESCE(renewal.event_created_at,renewal.created_at) END,
  GREATEST(0,COALESCE(renewal.gross_amount_cents,renewal.amount_cents+GREATEST(renewal.refunded_amount_cents,renewal.chargeback_amount_cents))
    -GREATEST(renewal.refunded_amount_cents,CASE WHEN renewal.chargeback_status IN ('reversed','resolved_reversal') THEN 0 ELSE renewal.chargeback_amount_cents END)),
  CASE WHEN renewal.refunded_amount_cents>0 THEN 'refunded' ELSE 'settle_ok' END,
  COALESCE(renewal.event_created_at,renewal.created_at),'legacy_observation','legacy_projection',renewal.invoice_created_at,TRUE
FROM public.renewal_events AS renewal
JOIN public.orders AS parent ON parent.payment_environment=renewal.payment_environment
  AND parent.solidgate_subscription_id=renewal.solidgate_subscription_id
WHERE renewal.solidgate_order_id IS NOT NULL AND renewal.solidgate_order_id<>parent.solidgate_order_id
ON CONFLICT DO NOTHING;
INSERT INTO public.solidgate_financial_movements (
  environment,event_key,solidgate_order_id,solidgate_invoice_id,solidgate_subscription_id,order_id,user_id,
  occurred_at,occurred_at_source,evidence_source,currency,captured_delta_cents,refunded_delta_cents,
  chargeback_delta_cents,net_delta_cents,resulting_captured_amount_cents,resulting_refunded_amount_cents,
  resulting_chargeback_amount_cents,resulting_net_amount_cents,facts
)
SELECT environment,'legacy-opening-balance',solidgate_order_id,solidgate_invoice_id,solidgate_subscription_id,order_id,user_id,
  COALESCE(first_captured_at,NOW()),'legacy_observation','legacy_projection',currency,captured_amount_cents,refunded_amount_cents,
  chargeback_amount_cents,captured_amount_cents::BIGINT-GREATEST(refunded_amount_cents,chargeback_amount_cents),
  captured_amount_cents,refunded_amount_cents,chargeback_amount_cents,net_amount_cents,
  '{"notice":"Estimated legacy projection. Reconcile against provider transactions; this is not transaction-time evidence."}'::JSONB
FROM public.solidgate_payment_balances WHERE capture_evidence_source='legacy_projection'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.bridge_solidgate_confirmed_order_capture()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_captured INTEGER;
BEGIN
  IF NEW.psp<>'solidgate' OR NEW.solidgate_order_id IS NULL
    OR COALESCE(pg_catalog.current_setting('app.solidgate_financial_order',TRUE),'')=NEW.id::TEXT
    OR NEW.status NOT IN ('completed','trialing','active')
    OR OLD.status NOT IN ('pending','failed')
    OR NEW.solidgate_payment_status NOT IN ('settle_ok','partial_settled')
    OR NOT (
      COALESCE(OLD.solidgate_payment_status,'') NOT IN ('settle_ok','partial_settled')
      OR (OLD.status NOT IN ('completed','trialing','active') AND NEW.status IN ('completed','trialing','active'))
    ) THEN RETURN NEW; END IF;
  -- This bridge covers the already-verified browser/saved-card completion
  -- writers. They only finalize a full quote. Webhook partial captures use
  -- the reducer directly and bypass this bridge via its transaction marker.
  v_captured:=LEAST(COALESCE(NEW.solidgate_original_amount_cents,NEW.amount_cents),
    GREATEST(0,NEW.amount_cents)+GREATEST(NEW.solidgate_refunded_amount_cents,NEW.solidgate_chargeback_amount_cents));
  IF v_captured<=0 THEN RETURN NEW; END IF;
  PERFORM public.apply_solidgate_financial_event(NEW.payment_environment,
    'local-confirmed-capture:'||NEW.id::TEXT||':'||v_captured::TEXT,NEW.solidgate_order_id,
    jsonb_build_object('order_db_id',NEW.id,'currency',NEW.currency,'captured_amount_cents',v_captured,
      'quoted_amount_cents',NEW.solidgate_original_amount_cents,'subscription_id',NEW.solidgate_subscription_id,
      'payment_status',NEW.solidgate_payment_status,'occurred_at',NOW(),'occurred_at_source','received_at'),
    jsonb_build_object('event_key','order:'||NEW.solidgate_order_id||':settled',
      'event_name',CASE WHEN NEW.solidgate_subscription_id IS NULL THEN 'purchase_completed'
        WHEN NEW.product_slug='BRANDADDON_000000_SUB' THEN 'oto_subscription_started' ELSE 'subscription_started' END,
      'distinct_id',COALESCE(NEW.session_id::TEXT,NEW.user_id::TEXT,NEW.solidgate_order_id),
      'insert_id',md5(NEW.payment_environment||':order:'||NEW.solidgate_order_id||':settled')::UUID,
      'properties',NEW.tracking_metadata||jsonb_build_object('session_id',NEW.session_id,'user_id',NEW.user_id,
        'solidgate_order_id',NEW.solidgate_order_id,'order_id',NEW.solidgate_order_id,'transaction_id',NEW.solidgate_order_id,
        'solidgate_subscription_id',NEW.solidgate_subscription_id,'subscription_id',NEW.solidgate_subscription_id,
        'amount_cents',v_captured,'product_slug',COALESCE(NEW.tracking_metadata->>'product_slug',NEW.product_slug),
        'billing_type',CASE WHEN NEW.solidgate_subscription_id IS NULL THEN 'one_time' ELSE 'subscription_initial' END,
        'provider','solidgate','payment_provider','solidgate','environment',NEW.payment_environment,
        'source','solidgate_confirmed_capture','surface',CASE WHEN NEW.session_id IS NULL THEN 'pwa' ELSE 'funnel' END)));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.bridge_solidgate_confirmed_order_capture() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_solidgate_confirmed_order_capture() TO service_role;
DROP TRIGGER IF EXISTS solidgate_confirmed_capture_ledger ON public.orders;
CREATE TRIGGER solidgate_confirmed_capture_ledger
  AFTER UPDATE OF amount_cents,solidgate_payment_status,status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.bridge_solidgate_confirmed_order_capture();

CREATE OR REPLACE VIEW public.solidgate_reconciliation_issues WITH (security_invoker=TRUE) AS
SELECT balance.environment,balance.order_id,balance.solidgate_order_id,balance.solidgate_invoice_id,
  balance.solidgate_subscription_id,
  CASE WHEN balance.capture_evidence_source='legacy_projection' THEN 'legacy_amount_requires_provider_reconciliation'
    WHEN balance.needs_reconciliation THEN 'reversal_exceeds_known_capture'
    WHEN balance.captured_amount_cents>0 AND balance.first_captured_at_source IS DISTINCT FROM 'provider_operation'
      THEN 'capture_time_is_estimated'
    ELSE 'paid_period_missing' END AS issue,
  balance.updated_at AS observed_at
FROM public.solidgate_payment_balances AS balance
WHERE balance.capture_evidence_source='legacy_projection' OR balance.needs_reconciliation
  OR (balance.captured_amount_cents>0 AND balance.first_captured_at_source IS DISTINCT FROM 'provider_operation')
  OR (balance.subscription_term_number>0 AND balance.captured_amount_cents>0 AND balance.period_end_at IS NULL)
UNION ALL
SELECT renewal.payment_environment,NULL::UUID,renewal.solidgate_order_id,renewal.solidgate_invoice_id,
  renewal.solidgate_subscription_id,'legacy_renewal_missing_order_binding',renewal.created_at
FROM public.renewal_events AS renewal WHERE renewal.solidgate_order_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.orders AS parent WHERE parent.payment_environment=renewal.payment_environment
    AND parent.solidgate_subscription_id=renewal.solidgate_subscription_id);
REVOKE ALL ON public.solidgate_reconciliation_issues FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.solidgate_reconciliation_issues TO service_role;


CREATE OR REPLACE FUNCTION public.open_solidgate_card_update_attempt(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_candidate_order_id TEXT,
  p_customer_email TEXT,
  p_checkout_locale TEXT,
  p_builder_token UUID
)
RETURNS TABLE (
  attempt_id UUID,
  solidgate_order_id TEXT,
  bound_customer_email TEXT,
  bound_checkout_locale TEXT,
  attempt_state TEXT,
  merchant_data JSONB,
  is_new BOOLEAN,
  should_build BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current public.solidgate_card_update_attempts%ROWTYPE;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_customer_email, '')));
  v_locale TEXT := BTRIM(COALESCE(p_checkout_locale, ''));
  v_expected_prefix TEXT := 'u-' || p_user_id::TEXT || ':card_update:';
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_builder_token IS NULL
     OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR CHAR_LENGTH(v_email) > 320
     OR v_locale NOT IN (
       'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el',
       'he', 'pl', 'hr', 'da', 'ja'
     )
     OR LEFT(COALESCE(p_candidate_order_id, ''), LENGTH(v_expected_prefix))
          IS DISTINCT FROM v_expected_prefix
     OR pg_catalog.split_part(p_candidate_order_id, ':', 3) !~ '^[1-9][0-9]{0,18}$'
     OR pg_catalog.split_part(p_candidate_order_id, ':', 4) <> '' THEN
    RAISE EXCEPTION 'invalid Solidgate card-update attempt binding'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-card-update:' || p_payment_environment || ':' || p_user_id::TEXT,
      0
    )
  );

  SELECT candidate.*
  INTO v_current
  FROM public.solidgate_card_update_attempts AS candidate
  WHERE candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.is_current
  FOR UPDATE;

  IF FOUND AND v_current.state IN ('issued','applying')
     AND v_current.created_at<NOW()-INTERVAL '48 hours'
     AND (v_current.apply_started_at IS NULL OR v_current.apply_started_at<NOW()-INTERVAL '30 seconds') THEN
    UPDATE public.solidgate_card_update_attempts AS candidate
      SET is_current=FALSE,state='failed',apply_token=NULL,apply_started_at=NULL,updated_at=NOW()
      WHERE candidate.id=v_current.id;
    v_current.state:='failed';
  END IF;

  IF FOUND AND v_current.state IN ('building', 'issued', 'applying') THEN
    IF v_current.state = 'building'
       AND v_current.builder_started_at < NOW() - INTERVAL '30 seconds' THEN
      UPDATE public.solidgate_card_update_attempts AS candidate
      SET builder_token = p_builder_token,
          builder_started_at = NOW(),
          updated_at = NOW()
      WHERE candidate.id = v_current.id
      RETURNING candidate.* INTO v_current;

      RETURN QUERY SELECT
        v_current.id,
        v_current.solidgate_order_id,
        v_current.customer_email,
        v_current.checkout_locale,
        v_current.state,
        v_current.merchant_data,
        FALSE,
        TRUE;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      v_current.id,
      v_current.solidgate_order_id,
      v_current.customer_email,
      v_current.checkout_locale,
      v_current.state,
      v_current.merchant_data,
      FALSE,
      FALSE;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE public.solidgate_card_update_attempts AS candidate
    SET is_current = FALSE,
        updated_at = NOW()
    WHERE candidate.id = v_current.id;
  END IF;

  INSERT INTO public.solidgate_card_update_attempts (
    payment_environment,
    user_id,
    solidgate_order_id,
    customer_email,
    checkout_locale,
    state,
    builder_token,
    builder_started_at
  ) VALUES (
    p_payment_environment,
    p_user_id,
    p_candidate_order_id,
    v_email,
    v_locale,
    'building',
    p_builder_token,
    NOW()
  )
  RETURNING * INTO v_current;

  RETURN QUERY SELECT
    v_current.id,
    v_current.solidgate_order_id,
    v_current.customer_email,
    v_current.checkout_locale,
    v_current.state,
    v_current.merchant_data,
    TRUE,
    TRUE;
END;
$$;


-- Authenticated ownership is required before an anonymous checkout card
-- can become an account card or influence existing subscription billing.
CREATE OR REPLACE FUNCTION public.write_solidgate_account_vault_monotonic(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_source_kind TEXT,
  p_source_id UUID,
  p_source_claim_token UUID,
  p_card_token TEXT,
  p_card_brand TEXT,
  p_card_last4 TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_created_at TIMESTAMPTZ;
  v_source_sequence BIGINT;
  v_source_text TEXT := p_source_id::TEXT;
  v_source_priority INTEGER;
  v_existing public.solidgate_account_vault%ROWTYPE;
  v_existing_priority INTEGER;
  v_attempt public.solidgate_card_update_attempts%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_pwa_state public.solidgate_pwa_purchase_states%ROWTYPE;
  v_session_origin_id UUID;
  v_token TEXT := NULLIF(BTRIM(COALESCE(p_card_token, '')), '');
  v_brand TEXT := NULLIF(BTRIM(COALESCE(p_card_brand, '')), '');
  v_last4 TEXT := NULLIF(BTRIM(COALESCE(p_card_last4, '')), '');
BEGIN
  IF p_payment_environment NOT IN ('production', 'sandbox')
     OR p_user_id IS NULL
     OR p_source_id IS NULL
     OR (v_last4 IS NOT NULL AND v_last4 !~ '^[0-9]{4}$') THEN
    RAISE EXCEPTION 'invalid Solidgate account vault source write'
      USING ERRCODE = '22023';
  END IF;

  IF p_source_kind = 'card_update' THEN
    -- A zero-auth update proves a new card only when the provider supplies its
    -- reusable token. Captured charge orders may still create watermarks.
    IF v_token IS NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_attempt
    FROM public.solidgate_card_update_attempts AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.is_current
    FOR SHARE;
    IF v_attempt.state IS DISTINCT FROM 'applying'
       OR v_attempt.apply_token IS DISTINCT FROM p_source_claim_token THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_attempt.created_at;
    v_source_sequence := v_attempt.source_sequence;
    v_source_priority := 3;
  ELSIF p_source_kind = 'pwa_order' THEN
    IF p_source_claim_token IS NOT NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_order
    FROM public.orders AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.session_id IS NULL
      AND candidate.psp = 'solidgate'
    FOR SHARE;
    SELECT state.*
    INTO STRICT v_pwa_state
    FROM public.solidgate_pwa_purchase_states AS state
    WHERE state.payment_environment = p_payment_environment
      AND state.user_id = p_user_id
      AND state.order_db_id = p_source_id
    FOR SHARE;
    IF v_order.solidgate_checkout_identity_legacy
       OR v_order.solidgate_card_source_sequence IS NULL
       OR v_order.status NOT IN (
         'completed', 'trialing', 'active', 'past_due', 'canceled'
       )
       OR NOT (
         (
           v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled')
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.amount_cents
                 IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
           AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
         )
         OR (
           v_order.solidgate_payment_status = 'refunded'
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents
                 < v_order.solidgate_original_amount_cents
           AND v_order.amount_cents IS NOT DISTINCT FROM (
             v_order.solidgate_original_amount_cents
               - v_order.solidgate_refunded_amount_cents
           )
         )
       )
       OR v_order.solidgate_chargeback_id IS NOT NULL
       OR v_order.solidgate_chargeback_status IS NOT NULL
       OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0
       OR v_pwa_state.purchase_mode IS DISTINCT FROM 'hosted_form'
       OR v_pwa_state.last_result_kind IS DISTINCT FROM 'captured' THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_order.created_at;
    v_source_sequence := v_order.solidgate_card_source_sequence;
    v_source_priority := 2;
  ELSIF p_source_kind = 'main_order' THEN
    IF p_source_claim_token IS NOT NULL THEN RETURN 'invalid'; END IF;
    SELECT candidate.*
    INTO STRICT v_order
    FROM public.orders AS candidate
    WHERE candidate.id = p_source_id
      AND candidate.payment_environment = p_payment_environment
      AND candidate.user_id = p_user_id
      AND candidate.session_id IS NOT NULL
      AND candidate.psp = 'solidgate'
      AND candidate.product_slug = 'BRAND_000000_SUB'
      AND candidate.product_name = 'BRAND_000000_SUB'
    FOR SHARE;
    -- Before any account generation, tokenless fence, or sync-job mutation.
    IF v_order.auth_verified_at IS NULL THEN RETURN 'unverified'; END IF;
    IF v_order.solidgate_checkout_identity_legacy
       OR v_order.solidgate_card_source_sequence IS NULL
       OR v_order.status NOT IN (
         'completed', 'trialing', 'active', 'past_due', 'canceled'
       )
       OR NOT (
         (
           v_order.solidgate_payment_status IN ('settle_ok', 'partial_settled')
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.amount_cents
                 IS NOT DISTINCT FROM v_order.solidgate_original_amount_cents
           AND v_order.solidgate_refunded_amount_cents IS NOT DISTINCT FROM 0
         )
         OR (
           v_order.solidgate_payment_status = 'refunded'
           AND v_order.solidgate_original_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents > 0
           AND v_order.solidgate_refunded_amount_cents
                 < v_order.solidgate_original_amount_cents
           AND v_order.amount_cents IS NOT DISTINCT FROM (
             v_order.solidgate_original_amount_cents
               - v_order.solidgate_refunded_amount_cents
           )
         )
         OR (
           v_order.solidgate_payment_status = 'auth_ok'
           AND v_order.solidgate_payment_action = 'auth_0_amount'
           AND v_order.solidgate_original_amount_cents = 0
           AND v_order.amount_cents = 0
           AND v_order.solidgate_refunded_amount_cents = 0
         )
       )
       OR v_order.solidgate_payment_status = 'void_ok'
       OR v_order.solidgate_chargeback_id IS NOT NULL
       OR v_order.solidgate_chargeback_status IS NOT NULL
       OR COALESCE(v_order.solidgate_chargeback_amount_cents, 0) > 0 THEN
      RETURN 'invalid';
    END IF;
    v_source_created_at := v_order.created_at;
    v_source_sequence := v_order.solidgate_card_source_sequence;
    v_source_priority := 1;
    v_session_origin_id := v_order.session_id;
  ELSE
    RETURN 'invalid';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'solidgate-account-vault:' || p_payment_environment || ':' || p_user_id::TEXT,
      0
    )
  );
  SELECT vault.*
  INTO v_existing
  FROM public.solidgate_account_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    v_existing_priority := CASE v_existing.card_source_kind
      WHEN 'card_update' THEN 3
      WHEN 'pwa_order' THEN 2
      WHEN 'main_order' THEN 1
      ELSE 0
    END;
    IF v_existing.card_source_kind = p_source_kind
       AND v_existing.card_source_id = v_source_text THEN
      IF v_existing.card_source_created_at IS DISTINCT FROM v_source_created_at
         OR v_existing.card_source_sequence IS DISTINCT FROM v_source_sequence
         OR v_existing.customer_account_id IS DISTINCT FROM p_user_id::TEXT
         OR (
           v_existing.card_token IS NOT NULL
           AND v_token IS NOT NULL
           AND v_existing.card_token IS DISTINCT FROM v_token
         ) THEN
        RAISE EXCEPTION 'same Solidgate vault source returned a different token'
          USING ERRCODE = '23514';
      END IF;

      -- A tokenless replay cannot erase richer evidence from this source.
      IF v_existing.card_token IS NOT NULL THEN
        PERFORM public.enqueue_solidgate_subscription_token_sync(
          p_payment_environment,
          p_user_id
        );
        RETURN 'same';
      END IF;

      -- Replaying a tokenless winner repairs any awaiting rows introduced by
      -- a delayed entitlement grant without making them claimable.
      IF v_token IS NULL THEN
        PERFORM public.fence_solidgate_subscription_token_sync_for_tokenless_source(
          p_payment_environment,
          p_user_id,
          p_source_kind,
          v_source_created_at,
          v_source_sequence,
          v_source_text
        );
        RETURN 'same';
      END IF;

      -- Fill the exact tokenless generation, then release only the jobs that
      -- this generation fenced. The usable token is durable before any worker
      -- can claim them.
      PERFORM pg_catalog.set_config(
        'app.solidgate_vault_source_write',
        p_source_kind || ':' || v_source_text,
        TRUE
      );
      UPDATE public.solidgate_account_vault AS vault
      SET card_token = v_token,
          card_brand = v_brand,
          card_last4 = v_last4,
          session_origin_id = COALESCE(
            v_session_origin_id,
            vault.session_origin_id
          ),
          updated_at = NOW()
      WHERE vault.payment_environment = p_payment_environment
        AND vault.user_id = p_user_id
        AND vault.card_source_kind = p_source_kind
        AND vault.card_source_id = v_source_text
        AND vault.card_token IS NULL;
      PERFORM pg_catalog.set_config(
        'app.solidgate_vault_source_write',
        '',
        TRUE
      );

      -- Enqueue selects only exact billable subscriptions whose own order is
      -- older than this source; unsafe/nonbillable awaiting rows stay fenced.
      PERFORM public.enqueue_solidgate_subscription_token_sync(
        p_payment_environment,
        p_user_id
      );
      RETURN 'written';
    END IF;
    IF (
      v_source_sequence,
      v_source_priority,
      v_source_text
    ) <= (
      v_existing.card_source_sequence,
      v_existing_priority,
      v_existing.card_source_id
    ) THEN
      -- Re-enqueue a previously failed job for the actual current winner. A
      -- stale browser return never queues its own obsolete token.
      PERFORM public.enqueue_solidgate_subscription_token_sync(
        p_payment_environment,
        p_user_id
      );
      RETURN 'stale';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.solidgate_vault_source_write',
    p_source_kind || ':' || v_source_text,
    TRUE
  );
  INSERT INTO public.solidgate_account_vault (
    user_id,
    payment_environment,
    customer_account_id,
    card_token,
    card_brand,
    card_last4,
    session_origin_id,
    card_source_kind,
    card_source_created_at,
    card_source_sequence,
    card_source_id,
    updated_at
  ) VALUES (
    p_user_id,
    p_payment_environment,
    p_user_id::TEXT,
    v_token,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_brand END,
    CASE WHEN v_token IS NULL THEN NULL ELSE v_last4 END,
    v_session_origin_id,
    p_source_kind,
    v_source_created_at,
    v_source_sequence,
    v_source_text,
    NOW()
  )
  ON CONFLICT (payment_environment, user_id) DO UPDATE
  SET customer_account_id = EXCLUDED.customer_account_id,
      card_token = EXCLUDED.card_token,
      card_brand = EXCLUDED.card_brand,
      card_last4 = EXCLUDED.card_last4,
      session_origin_id = COALESCE(
        EXCLUDED.session_origin_id,
        public.solidgate_account_vault.session_origin_id
      ),
      card_source_kind = EXCLUDED.card_source_kind,
      card_source_created_at = EXCLUDED.card_source_created_at,
      card_source_sequence = EXCLUDED.card_source_sequence,
      card_source_id = EXCLUDED.card_source_id,
      updated_at = NOW();
  PERFORM pg_catalog.set_config(
    'app.solidgate_vault_source_write',
    '',
    TRUE
  );

  IF v_token IS NULL THEN
    PERFORM public.fence_solidgate_subscription_token_sync_for_tokenless_source(
      p_payment_environment,
      p_user_id,
      p_source_kind,
      v_source_created_at,
      v_source_sequence,
      v_source_text
    );
  ELSE
    PERFORM public.enqueue_solidgate_subscription_token_sync(
      p_payment_environment,
      p_user_id
    );
  END IF;
  RETURN 'written';
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_solidgate_session_vault_monotonic(
  p_payment_environment TEXT,
  p_user_id UUID,
  p_session_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_card public.solidgate_session_vault%ROWTYPE;
BEGIN
  SELECT vault.*
  INTO v_card
  FROM public.solidgate_session_vault AS vault
  WHERE vault.payment_environment = p_payment_environment
    AND vault.session_id = p_session_id
  FOR SHARE;
  IF NOT FOUND
     OR v_card.card_source_legacy
     OR v_card.card_source_order_id IS NULL
     OR v_card.card_source_sequence IS NULL THEN
    RETURN 'missing';
  END IF;

  SELECT candidate.*
  INTO v_order
  FROM public.orders AS candidate
  WHERE candidate.id = v_card.card_source_order_id
    AND candidate.payment_environment = p_payment_environment
    AND candidate.user_id = p_user_id
    AND candidate.session_id = p_session_id
    AND candidate.psp = 'solidgate'
    AND candidate.product_slug = 'BRAND_000000_SUB'
    AND candidate.product_name = 'BRAND_000000_SUB'
    AND candidate.status IN (
      'completed', 'trialing', 'active', 'past_due', 'canceled'
    )
    AND NOT candidate.solidgate_checkout_identity_legacy
    AND candidate.solidgate_card_source_sequence = v_card.card_source_sequence
  FOR SHARE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF v_order.auth_verified_at IS NULL THEN RETURN 'unverified'; END IF;

  RETURN public.write_solidgate_account_vault_monotonic(
    p_payment_environment,
    p_user_id,
    'main_order',
    v_order.id,
    NULL,
    v_card.card_token,
    v_card.card_brand,
    v_card.card_last4
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_solidgate_order_auth_proof_on_owner_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  -- Auth proof belongs to an exact account. This also runs when auth.users
  -- deletion clears orders.user_id through its ON DELETE SET NULL foreign key.
  -- Verified claim handlers write the proof separately after owner assignment.
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN NEW.auth_verified_at:=NULL; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_solidgate_order_auth_proof_on_owner_change() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS clear_solidgate_order_auth_proof_owner_change ON public.orders;
CREATE TRIGGER clear_solidgate_order_auth_proof_owner_change
  BEFORE UPDATE OF user_id ON public.orders FOR EACH ROW
  EXECUTE FUNCTION public.clear_solidgate_order_auth_proof_on_owner_change();
