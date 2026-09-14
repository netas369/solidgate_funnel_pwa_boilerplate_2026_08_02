-- Throwaway-database fixture cleanup only. Production history remains immutable
-- and parent deletion is deliberately blocked by foreign keys. Tests which
-- commit fixtures for dblink must explicitly clear their own history to repeat.
CREATE OR REPLACE FUNCTION pg_temp.clear_solidgate_financial_test_orders(p_ids UUID[])
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE public.solidgate_capture_transactions DISABLE TRIGGER USER;
  ALTER TABLE public.solidgate_financial_movements DISABLE TRIGGER USER;
  ALTER TABLE public.solidgate_subscription_history DISABLE TRIGGER USER;
  DELETE FROM public.solidgate_analytics_outbox WHERE properties->>'solidgate_order_id' IN
    (SELECT solidgate_order_id FROM public.orders WHERE id=ANY(p_ids));
  DELETE FROM public.solidgate_capture_transactions AS capture USING public.solidgate_payment_balances AS balance
    WHERE capture.environment=balance.environment AND capture.solidgate_order_id=balance.solidgate_order_id AND balance.order_id=ANY(p_ids);
  DELETE FROM public.solidgate_financial_movements WHERE order_id=ANY(p_ids);
  DELETE FROM public.solidgate_subscription_history WHERE order_id=ANY(p_ids);
  DELETE FROM public.solidgate_subscription_snapshots WHERE order_id=ANY(p_ids);
  DELETE FROM public.solidgate_payment_balances WHERE order_id=ANY(p_ids);
  ALTER TABLE public.solidgate_capture_transactions ENABLE TRIGGER USER;
  ALTER TABLE public.solidgate_financial_movements ENABLE TRIGGER USER;
  ALTER TABLE public.solidgate_subscription_history ENABLE TRIGGER USER;
END;
$$;
