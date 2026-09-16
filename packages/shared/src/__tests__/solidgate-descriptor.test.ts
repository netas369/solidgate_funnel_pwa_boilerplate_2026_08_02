import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_ID_TO_CODE, SOLIDGATE_PRODUCT_CODES } from '../solidgate/catalog';
import type { SolidgateClient } from '../solidgate/client';
import { chargeSavedCard, subscribeSavedCard } from '../solidgate/oto';
import { solidgateOrderDescription } from '../locale-prefixes';

const oneTimeProducts = [
  'oto1_lifetime',
  'oto3_bundle_all',
  'oto3_bundle_1',
  'oto3_bundle_2',
  'oto3_bundle_3',
  'oto4_pdf',
  'oto5_pdf',
  'oto6_pdf',
  'oto7_pdf',
] as const;

function capturedClient(amount: number) {
  return {
    recurring: vi.fn().mockResolvedValue({
      order: { status: 'settle_ok', amount },
    }),
    status: vi.fn(),
  };
}

describe('static statement descriptor on saved-card payments', () => {
  it.each(oneTimeProducts)('omits the descriptor override for %s', async (productSlug) => {
    const amount = 9_900;
    const client = capturedClient(amount);
    const description = solidgateOrderDescription(
      'cs', PRODUCT_ID_TO_CODE[productSlug], SOLIDGATE_PRODUCT_CODES.main,
    );

    await chargeSavedCard(client as unknown as SolidgateClient, {
      orderId: `session:${productSlug}:1`,
      recurringToken: 'token',
      paymentType: '1-click',
      amount,
      currency: 'czk',
      orderDescription: description,
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
      metadata: { product_slug: productSlug, locale: 'cs' },
    });

    expect(client.recurring).toHaveBeenCalledTimes(1);
    const [request] = client.recurring.mock.calls[0];
    expect(request).not.toHaveProperty('dynamic_descriptor');
    expect(request).toMatchObject({
      order_description: `CZ_${PRODUCT_ID_TO_CODE[productSlug]} o:CZ_${SOLIDGATE_PRODUCT_CODES.main}`,
      amount,
      currency: 'CZK',
      order_metadata: { product_slug: productSlug, locale: 'cs' },
    });
  });

  it('omits the descriptor override when creating the independent OTO2 subscription', async () => {
    const client = capturedClient(500);
    await subscribeSavedCard(client as unknown as SolidgateClient, {
      orderId: 'session:oto2_addon_weekly:1',
      recurringToken: 'token',
      paymentType: '1-click',
      productId: 'addon-product',
      expectedAmount: 500,
      currency: 'eur',
      orderDescription: solidgateOrderDescription('lt', SOLIDGATE_PRODUCT_CODES.addon),
      customerAccountId: 'customer',
      customerEmail: 'buyer@example.com',
      ipAddress: '203.0.113.1',
      metadata: { product_slug: 'oto2_addon_weekly', locale: 'lt' },
    });

    expect(client.recurring).toHaveBeenCalledTimes(1);
    const [request] = client.recurring.mock.calls[0];
    expect(request).not.toHaveProperty('dynamic_descriptor');
    expect(request).not.toHaveProperty('amount');
    expect(request).toMatchObject({
      product_id: 'addon-product',
      currency: 'EUR',
      order_description: `LT_${SOLIDGATE_PRODUCT_CODES.addon}`,
      order_metadata: { product_slug: 'oto2_addon_weekly', locale: 'lt' },
    });
  });
});
