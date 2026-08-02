import { beforeEach, describe, expect, it } from 'vitest';
import { FUNNEL_CODE } from '@/features/analytics/lib/checkout-context';
import {
  clearMainPaymentRecovery,
  MAIN_PAYMENT_RECOVERY_MAX_AGE_MS,
  MAIN_PAYMENT_RECOVERY_STORAGE_KEY,
  parseMainPaymentRecoveryOrder,
  readMainPaymentRecovery,
  saveMainPaymentRecovery,
} from '../main-payment-recovery';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:trial3:1`;

describe('main payment recovery marker', () => {
  beforeEach(() => localStorage.clear());

  it('persists and restores one canonical main order within the bounded window', () => {
    const now = 1_784_660_000_000;
    expect(saveMainPaymentRecovery({ orderId: ORDER_ID, sessionId: SESSION_ID }, localStorage, now))
      .toMatchObject({ orderId: ORDER_ID, sessionId: SESSION_ID, createdAt: now });
    expect(readMainPaymentRecovery(localStorage, now + 5_000)).toMatchObject({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
    });
  });

  it('preserves only validated capture analytics needed after ownership handoff', () => {
    const checkout = {
      payment_provider: 'solidgate' as const,
      billing_type: 'subscription_initial' as const,
      surface: 'funnel' as const,
      funnel_code: FUNNEL_CODE as typeof FUNNEL_CODE,
      funnel_variant: 'main' as const,
      product: 'trial3' as const,
      product_id: `${FUNNEL_CODE}_000000_SUB`,
      product_code: `${FUNNEL_CODE}_000000_SUB`,
      product_name: 'Main Subscription',
      product_slug: 'trial3' as const,
      price_id: 'price-1',
      solidgate_product_id: 'product-1',
      solidgate_price_id: 'price-1',
      amount_cents: 1300,
      currency: 'USD',
    };
    saveMainPaymentRecovery({ orderId: ORDER_ID, sessionId: SESSION_ID, checkout }, localStorage);
    expect(readMainPaymentRecovery(localStorage)?.checkout).toEqual(checkout);
  });

  it.each([
    `${SESSION_ID}:oto1_lifetime:1`,
    `${SESSION_ID}:trial3:01`,
    `not-a-uuid:trial3:1`,
    `${SESSION_ID}:trial3:0`,
  ])('rejects a non-canonical or non-main order: %s', (orderId) => {
    expect(parseMainPaymentRecoveryOrder(orderId)).toBeNull();
    expect(saveMainPaymentRecovery({ orderId, sessionId: SESSION_ID }, localStorage)).toBeNull();
  });

  it('expires and deletes a stale marker', () => {
    const now = 1_784_660_000_000;
    saveMainPaymentRecovery({ orderId: ORDER_ID, sessionId: SESSION_ID }, localStorage, now);
    expect(readMainPaymentRecovery(
      localStorage,
      now + MAIN_PAYMENT_RECOVERY_MAX_AGE_MS + 1,
    )).toBeNull();
    expect(localStorage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('removes malformed storage and supports explicit cleanup', () => {
    localStorage.setItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY, '{');
    expect(readMainPaymentRecovery(localStorage)).toBeNull();
    saveMainPaymentRecovery({ orderId: ORDER_ID, sessionId: SESSION_ID }, localStorage);
    clearMainPaymentRecovery(localStorage);
    expect(localStorage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY)).toBeNull();
  });
});
