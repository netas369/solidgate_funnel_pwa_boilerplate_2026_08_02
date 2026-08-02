/**
 * Durable state which must win over a provider status response.
 *
 * Solidgate can continue returning `settle_ok` for the original payment after
 * we have cancelled/refunded/disputed it locally. A browser replay of an old
 * confirmation must therefore never treat the provider status as sufficient
 * authority to grant access again.
 */
export interface SolidgateGrantOrderState {
  status?: string | null;
  solidgate_payment_status?: string | null;
  solidgate_refunded_amount_cents?: number | null;
  solidgate_chargeback_id?: string | null;
  solidgate_chargeback_status?: string | null;
  solidgate_chargeback_amount_cents?: number | null;
}

export interface SolidgateGrantEntitlementState {
  status?: string | null;
  revoked_at?: string | null;
}

/**
 * Route-level confirmation is only valid while an order is pending, or when
 * retrying an already successful grant. `failed`/`past_due` are intentionally
 * excluded: their recovery belongs to the ordered webhook lifecycle, not to a
 * stale browser confirmation.
 */
export const SOLIDGATE_CONFIRM_GRANTABLE_ORDER_STATUSES = [
  'pending',
  'completed',
  'trialing',
  'active',
] as const;

const CONFIRM_GRANTABLE = new Set<string>(SOLIDGATE_CONFIRM_GRANTABLE_ORDER_STATUSES);
const TERMINAL_PAYMENT_STATUSES = new Set(['void_ok']);

export type SolidgateGrantBlockReason =
  | 'order_status'
  | 'payment_status'
  | 'chargeback'
  | 'entitlement_revoked';

export function solidgateGrantBlockReason(
  order: SolidgateGrantOrderState,
  entitlement?: SolidgateGrantEntitlementState | null,
): SolidgateGrantBlockReason | null {
  if (!order.status || !CONFIRM_GRANTABLE.has(order.status)) return 'order_status';
  if (order.solidgate_payment_status && TERMINAL_PAYMENT_STATUSES.has(order.solidgate_payment_status)) {
    return 'payment_status';
  }
  // `solidgate_payment_status=refunded` and a positive refunded amount may be
  // a PARTIAL refund. The lifecycle handler only changes order.status to
  // `refunded` when the net amount reaches zero, so the status whitelist above
  // is the authoritative full-refund signal. Partial refunds retain access.
  if (
    order.solidgate_chargeback_id ||
    order.solidgate_chargeback_status ||
    (order.solidgate_chargeback_amount_cents ?? 0) > 0
  ) {
    // A reversal restores revenue, but intentionally does not restore access.
    return 'chargeback';
  }
  if (entitlement && (entitlement.status === 'canceled' || entitlement.revoked_at)) {
    return 'entitlement_revoked';
  }
  return null;
}
