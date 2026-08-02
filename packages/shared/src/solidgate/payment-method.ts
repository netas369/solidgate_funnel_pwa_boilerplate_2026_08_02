export const SOLIDGATE_ORIGINAL_PAYMENT_METHODS = [
  'card',
  'apple-pay',
  'google-pay',
  'network-token',
  'click-to-pay',
] as const;

export type SolidgateOriginalPaymentMethod = (typeof SOLIDGATE_ORIGINAL_PAYMENT_METHODS)[number];

export type SolidgateReusablePaymentType = '1-click' | 'rebill';

/**
 * Parses provider-owned token provenance without guessing from card metadata.
 * Unknown values intentionally become null so saved-token charging fails closed.
 */
export function parseSolidgateOriginalPaymentMethod(
  value: unknown,
): SolidgateOriginalPaymentMethod | null {
  return typeof value === 'string' &&
    (SOLIDGATE_ORIGINAL_PAYMENT_METHODS as readonly string[]).includes(value)
    ? (value as SolidgateOriginalPaymentMethod)
    : null;
}

/**
 * Selects the only reusable payment type allowed for the observed token origin.
 * Click to Pay is retained as provenance but is not eligible for recurring/MIT
 * reuse, so it deliberately returns null.
 */
export function paymentTypeForOriginalPaymentMethod(
  value: unknown,
): SolidgateReusablePaymentType | null {
  switch (parseSolidgateOriginalPaymentMethod(value)) {
    case 'card':
    case 'network-token':
      return '1-click';
    case 'apple-pay':
    case 'google-pay':
      return 'rebill';
    default:
      return null;
  }
}
