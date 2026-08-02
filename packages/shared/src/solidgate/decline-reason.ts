// Buyer-facing decline reasons for Solidgate gateway error codes.
//
// The status API and the hosted-form `fail` event both carry a dotted gateway
// code (https://docs.solidgate.com/payments/payments-insights/error-codes/).
// Raw codes must never reach a buyer, so this maps the actionable families to
// stable message keys the checkout i18n carries in every locale. Codes that are
// deliberately absent — 3.10 and the whole 4.xx antifraud family — fall through
// to the generic decline copy: telling a fraudster why a card was refused is a
// worse outcome than a vague message for the rare honest hit.

export const SOLIDGATE_DECLINE_REASONS = [
  'decline_insufficient_funds',
  'decline_expired_card',
  'decline_invalid_card_data',
  'decline_card_blocked',
  'decline_contact_bank',
  'decline_limit_exceeded',
  'decline_card_not_supported',
  'decline_verification_failed',
] as const;

export type SolidgateDeclineReason = (typeof SOLIDGATE_DECLINE_REASONS)[number];

const CODE_TO_REASON: Record<string, SolidgateDeclineReason> = {
  '2.04': 'decline_card_not_supported', // Card brand is not supported
  '2.06': 'decline_invalid_card_data', // Invalid CVV2 code
  '2.08': 'decline_invalid_card_data', // Invalid card number
  '2.09': 'decline_expired_card', // Invalid expiration date
  '3.01': 'decline_card_blocked', // Card is blocked
  '3.02': 'decline_insufficient_funds', // Insufficient funds
  '3.03': 'decline_limit_exceeded', // Payment amount limit excess
  '3.04': 'decline_contact_bank', // Transaction is declined by issuer
  '3.05': 'decline_contact_bank', // Call your bank
  '3.06': 'decline_card_not_supported', // Debit card not supported
  '3.07': 'decline_card_not_supported', // Card brand is not supported
  '3.08': 'decline_contact_bank', // Do not honor
  '3.09': 'decline_verification_failed', // 3D Secure authentication required
  '3.12': 'decline_card_blocked', // Closed account
  '5.01': 'decline_verification_failed', // 3D Secure verification failed
};

export function solidgateDeclineReason(code: unknown): SolidgateDeclineReason | null {
  if (typeof code !== 'string') return null;
  return CODE_TO_REASON[code.trim()] ?? null;
}

/** Reads the `error` object of a status API response ({ code, messages, … }). */
export function solidgateDeclineReasonFromStatusError(
  error: unknown,
): SolidgateDeclineReason | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  return solidgateDeclineReason((error as { code?: unknown }).code);
}
