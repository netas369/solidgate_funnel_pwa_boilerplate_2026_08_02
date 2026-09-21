// Account-scoped saved card (solidgate_account_vault).
//
// The funnel vaults the token against a SESSION (an anonymous buyer has no
// account yet). The member area charges an ACCOUNT. Promotion requires a
// verified mailbox owner claiming that exact purchase journey; assigning an
// account from checkout email must never replace its existing saved card.
//
// The table key includes the payment environment. Preview can therefore test
// one-click payments without overwriting the live recurring token.

import type { SupabaseClient } from '@supabase/supabase-js';
import { last4FromMaskedPan, type SolidgateCardInfo } from './session-vault';
import {
  parseSolidgateOriginalPaymentMethod,
  type SolidgateOriginalPaymentMethod,
} from './payment-method';
import { currentPaymentEnvironment, type PaymentEnvironment } from '../payment-environment';

export interface SolidgateAccountVault {
  paymentEnvironment: PaymentEnvironment;
  userId: string;
  customerAccountId: string;
  cardToken: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardOriginalPaymentMethod: SolidgateOriginalPaymentMethod | null;
}

export async function getAccountVault(
  supabase: SupabaseClient,
  userId: string,
  paymentEnvironment: PaymentEnvironment = currentPaymentEnvironment(),
): Promise<SolidgateAccountVault | null> {
  const { data, error } = await supabase
    .from('solidgate_account_vault')
    .select(
      'user_id, customer_account_id, card_token, card_brand, card_last4, card_original_payment_method, card_source_kind, card_source_id',
    )
    .eq('payment_environment', paymentEnvironment)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`account vault read failed: ${error.message}`);
  if (!data) return null;
  const sourceBound =
    ['main_order', 'pwa_order', 'card_update'].includes(data.card_source_kind) &&
    typeof data.card_source_id === 'string' &&
    data.card_source_id !== 'legacy';
  const originalPaymentMethod = parseSolidgateOriginalPaymentMethod(
    data.card_original_payment_method,
  );
  const usableCard = sourceBound && Boolean(data.card_token) && originalPaymentMethod !== null;
  return {
    paymentEnvironment,
    userId: data.user_id,
    customerAccountId: data.customer_account_id,
    cardToken: usableCard ? data.card_token : null,
    cardBrand: usableCard ? data.card_brand : null,
    cardLast4: usableCard ? data.card_last4 : null,
    cardOriginalPaymentMethod: usableCard ? originalPaymentMethod : null,
  };
}

export async function upsertAccountVault(
  supabase: SupabaseClient,
  params: {
    userId: string;
    card: SolidgateCardInfo;
    /** Database UUID of the already-captured hosted-form PWA order. */
    sourceOrderId: string;
    paymentEnvironment?: PaymentEnvironment;
  },
): Promise<void> {
  const paymentEnvironment = params.paymentEnvironment ?? currentPaymentEnvironment();
  const token = params.card.token ?? null;
  const originalPaymentMethod = parseSolidgateOriginalPaymentMethod(
    params.card.originalPaymentMethod,
  );

  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('write_solidgate_account_vault_with_method', {
    p_payment_environment: paymentEnvironment,
    p_user_id: params.userId,
    p_source_kind: 'pwa_order',
    p_source_id: params.sourceOrderId,
    p_source_claim_token: null,
    p_card_token: token,
    p_card_brand: params.card.brand ?? null,
    p_card_last4: last4FromMaskedPan(params.card.maskedNumber),
    p_original_payment_method: token ? originalPaymentMethod : null,
  });
  if (error) throw new Error(`account vault source write failed: ${error.message}`);
  if (!['written', 'same', 'stale'].includes(String(data))) {
    throw new Error(`account vault source write was rejected: ${String(data)}`);
  }
}

/**
 * Promotes the card after verified authentication claims its exact purchase.
 * The SQL source guard returns unverified until orders.auth_verified_at exists.
 * Idempotent. A tokenless exact session source still promotes its chronology
 * watermark so delayed older evidence cannot restore an obsolete account card.
 */
export async function promoteSessionVaultToAccount(
  supabase: SupabaseClient,
  params: {
    userId: string;
    sessionId: string;
    paymentEnvironment?: PaymentEnvironment;
  },
): Promise<void> {
  const paymentEnvironment = params.paymentEnvironment ?? currentPaymentEnvironment();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('promote_solidgate_session_vault_with_method', {
    p_payment_environment: paymentEnvironment,
    p_user_id: params.userId,
    p_session_id: params.sessionId,
  });
  if (error) throw new Error(`promote session vault failed: ${error.message}`);
  if (!['written', 'same', 'stale', 'unverified'].includes(String(data))) {
    throw new Error(`promote session vault returned an invalid result: ${String(data)}`);
  }
}
