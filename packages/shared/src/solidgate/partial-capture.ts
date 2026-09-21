import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentEnvironment } from '../payment-environment';

/** Call only after the provider response matches the immutable opened checkout. */
export async function persistSolidgatePartialCapture(
  db: SupabaseClient,
  input: {
    environment: PaymentEnvironment;
    orderDbId: string;
    orderId: string;
    quotedAmountCents: number;
    capturedAmountCents: number | null | undefined;
    currency: string;
    providerStatus: string | undefined;
    sessionId?: string | null;
    userId?: string | null;
    productCode?: string;
  },
): Promise<boolean> {
  const captured = input.capturedAmountCents;
  if (input.providerStatus !== 'partial_settled' || !Number.isSafeInteger(captured)
    || captured! <= 0 || captured! >= input.quotedAmountCents) return false;
  if (!input.orderDbId || !input.orderId || !Number.isSafeInteger(input.quotedAmountCents)
    || !/^[a-z]{3}$/i.test(input.currency)) throw new Error('Invalid partial capture binding');
  const eventKey = `order:${input.orderId}:captured:${captured}`;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`solidgate:${eventKey}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const insertId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const { data, error } = await db.rpc('apply_solidgate_financial_event', {
    p_environment: input.environment,
    p_event_key: `observed-partial-capture:${input.orderId}:${captured}`,
    p_solidgate_order_id: input.orderId,
    p_facts: {
      order_db_id: input.orderDbId, currency: input.currency.toLowerCase(),
      quoted_amount_cents: input.quotedAmountCents, captured_amount_cents: captured,
      payment_status: 'partial_settled', occurred_at_source: 'received_at',
    },
    p_analytics: input.environment === 'production' ? {
      event_key: eventKey, event_name: 'payment_captured', insert_id: insertId,
      distinct_id: input.sessionId ?? input.userId ?? input.orderId,
      properties: { provider: 'solidgate', payment_provider: 'solidgate', environment: input.environment,
        solidgate_order_id: input.orderId, order_id: input.orderId, transaction_id: input.orderId,
        session_id: input.sessionId, user_id: input.userId, product_code: input.productCode,
        amount_cents: captured, currency: input.currency.toUpperCase(), source: 'verified_provider_observation' },
    } : null,
  });
  if (error || !data || typeof data !== 'object') {
    throw new Error(`Partial capture persistence failed: ${error?.message ?? 'missing durable financial state'}`);
  }
  return true;
}
