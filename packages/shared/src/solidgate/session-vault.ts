// Session-scoped saved-card vault (solidgate_session_vault, migration 00039).
//
// Binds a funnel session to its PSP customer/order identity, replacing the
// `default_payment_method`: it holds the reusable `recurring_token` that powers
// the one-click OTO chain, plus the card brand/last4 the one-click UI shows.
//
// Lives in its own table because `sessions` is client-writable through
// PostgREST (anon INSERT, owner UPDATE) and Supabase's table-wide grants make a
// column-level REVOKE useless — an anon-planted card token would persist. This
// table has RLS on and zero policies, so only service-role writers reach it.
//
// Callers MUST pass a service-role Supabase client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { currentPaymentEnvironment, type PaymentEnvironment } from '../payment-environment';
import {
  parseSolidgateOriginalPaymentMethod,
  type SolidgateOriginalPaymentMethod,
} from './payment-method';

export interface SolidgateVaultEntry {
  paymentEnvironment: PaymentEnvironment;
  sessionId: string;
  customerAccountId: string;
  sourceOrderId: string | null;
  cardToken: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardOriginalPaymentMethod: SolidgateOriginalPaymentMethod | null;
}

/** Card details as they arrive on a Solidgate order transaction. */
export interface SolidgateCardInfo {
  token?: string | null;
  brand?: string | null;
  /** Masked PAN, e.g. "406742XXXXXX9265". */
  maskedNumber?: string | null;
  /** Provider-owned provenance from card_token.original_payment_method. */
  originalPaymentMethod?: string | null;
}

export function last4FromMaskedPan(masked?: string | null): string | null {
  if (!masked) return null;
  const digits = masked.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Writes the exact captured main-order generation. A tokenless capture still
 * advances the source watermark, while the same source may fill its token
 * later and a poorer retry can never wipe an already stored token.
 */
export async function upsertSessionVault(
  supabase: SupabaseClient,
  entry: {
    sessionId: string;
    /** Database UUID of the exact captured main order that produced the token. */
    sourceOrderId: string;
    customerAccountId: string;
    card?: SolidgateCardInfo | null;
    paymentEnvironment?: PaymentEnvironment;
  },
): Promise<void> {
  const paymentEnvironment = entry.paymentEnvironment ?? currentPaymentEnvironment();
  const token = entry.card?.token ?? null;
  const originalPaymentMethod = parseSolidgateOriginalPaymentMethod(
    entry.card?.originalPaymentMethod,
  );

  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('write_solidgate_session_vault_with_method', {
    p_payment_environment: paymentEnvironment,
    p_session_id: entry.sessionId,
    p_source_order_id: entry.sourceOrderId,
    p_customer_account_id: entry.customerAccountId,
    p_card_token: token,
    p_card_brand: entry.card?.brand ?? null,
    p_card_last4: last4FromMaskedPan(entry.card?.maskedNumber),
    p_original_payment_method: token ? originalPaymentMethod : null,
  });
  if (error) throw new Error(`solidgate_session_vault source write failed: ${error.message}`);
  if (!['written', 'same', 'stale'].includes(String(data))) {
    throw new Error(`solidgate_session_vault source write was rejected: ${String(data)}`);
  }
}

export async function getSessionVault(
  supabase: SupabaseClient,
  sessionId: string,
  paymentEnvironment: PaymentEnvironment = currentPaymentEnvironment(),
): Promise<SolidgateVaultEntry | null> {
  const { data, error } = await supabase
    .from('solidgate_session_vault')
    .select(
      'session_id, customer_account_id, card_token, card_brand, card_last4, card_original_payment_method, card_source_order_id, card_source_legacy',
    )
    .eq('payment_environment', paymentEnvironment)
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`solidgate_session_vault read failed: ${error.message}`);
  if (!data) return null;
  const sourceBound = !data.card_source_legacy && Boolean(data.card_source_order_id);
  const originalPaymentMethod = parseSolidgateOriginalPaymentMethod(
    data.card_original_payment_method,
  );
  const usableCard = sourceBound && Boolean(data.card_token) && originalPaymentMethod !== null;
  return {
    paymentEnvironment,
    sessionId: data.session_id,
    customerAccountId: data.customer_account_id,
    sourceOrderId: sourceBound ? data.card_source_order_id : null,
    cardToken: usableCard ? data.card_token : null,
    cardBrand: usableCard ? data.card_brand : null,
    cardLast4: usableCard ? data.card_last4 : null,
    cardOriginalPaymentMethod: usableCard ? originalPaymentMethod : null,
  };
}
