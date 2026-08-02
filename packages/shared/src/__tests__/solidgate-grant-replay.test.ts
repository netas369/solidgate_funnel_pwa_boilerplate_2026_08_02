import { describe, expect, it } from 'vitest';
import { solidgateGrantBlockReason } from '../solidgate/grant-replay';

describe('Solidgate confirmation replay guard', () => {
  it('keeps pending grants and already-completed happy-path retries idempotent', () => {
    expect(solidgateGrantBlockReason({ status: 'pending' })).toBeNull();
    expect(
      solidgateGrantBlockReason(
        { status: 'completed', solidgate_payment_status: 'settle_ok' },
        { status: 'active', revoked_at: null },
      ),
    ).toBeNull();
  });

  it.each([
    [{ status: 'canceled' }, 'order_status'],
    [{ status: 'refunded' }, 'order_status'],
    [{ status: 'disputed' }, 'order_status'],
    [{ status: 'completed', solidgate_payment_status: 'void_ok' }, 'payment_status'],
    [{ status: 'completed', solidgate_chargeback_id: 'cb-1' }, 'chargeback'],
    // A reversed chargeback restores revenue, not access.
    [{ status: 'completed', solidgate_chargeback_status: 'reversed' }, 'chargeback'],
  ] as const)('blocks terminal order state %#', (order, expected) => {
    expect(solidgateGrantBlockReason(order)).toBe(expected);
  });

  it('does not confuse a partial refund with a full-refund revoke', () => {
    expect(solidgateGrantBlockReason({
      status: 'completed',
      solidgate_payment_status: 'refunded',
      solidgate_refunded_amount_cents: 500,
    })).toBeNull();
  });

  it('blocks an explicit entitlement revocation linked to the purchase', () => {
    expect(
      solidgateGrantBlockReason(
        { status: 'completed' },
        { status: 'canceled', revoked_at: '2026-07-16T10:00:00.000Z' },
      ),
    ).toBe('entitlement_revoked');
  });
});
