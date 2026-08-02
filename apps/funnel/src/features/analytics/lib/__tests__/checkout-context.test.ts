import { describe, expect, it } from 'vitest';
import { PRICE_MAP, PRODUCT_CODE_PREFIX } from '@repo/shared/price-map';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import {
  FUNNEL_CODE,
  checkoutProductContext,
  isSubscriptionOto,
  lifecycleEventId,
  otoProductContext,
  purchaseEventId,
} from '../checkout-context';

describe('canonical payment product context', () => {
  it('derives the funnel code from the product-code grammar', () => {
    // Three verifiers (proxy.ts, solidgate-access.ts, solidgate/grant) assert
    // this exact value against Solidgate tracking_metadata. Renaming the brand
    // token must move all four together or every payment path fails closed.
    expect(FUNNEL_CODE).toBe(PRODUCT_CODE_PREFIX);
  });

  it('returns null for a main checkout tier while catalog-ids.json is unseeded', () => {
    // The boilerplate ships catalog-ids.json scrubbed to empty strings. Until
    // `npx tsx scripts/solidgate-seed-catalog.ts --apply` runs against a real
    // merchant account there is no PSP product/price to bind, and a null
    // context is what stops checkout from opening with a fabricated id.
    expect(checkoutProductContext('trial3', 'lt')).toBeNull();
  });

  it('represents amount-based OTOs without inventing a catalog price ID', () => {
    expect(isSubscriptionOto('oto3_bundle_all')).toBe(false);
    expect(otoProductContext('oto3_bundle_all', 'lt')).toMatchObject({
      billing_type: 'one_time',
      funnel_code: FUNNEL_CODE,
      funnel_variant: 'oto3',
      product_id: SOLIDGATE_PRODUCT_CODES.bundleAll,
      product_name: 'Bundle (all)',
      product_slug: 'oto3_bundle_all',
      price_id: null,
      solidgate_product_id: null,
      solidgate_price_id: null,
      amount_cents: PRICE_MAP.oto3_bundle_all.lt.amountCents,
      currency: 'EUR',
    });
  });

  it('reports a subscription OTO with a zero intro and its future recurring amount', () => {
    expect(isSubscriptionOto('oto2_addon_weekly')).toBe(true);
    expect(otoProductContext('oto2_addon_weekly', 'lt')).toMatchObject({
      billing_type: 'subscription_initial',
      funnel_variant: 'oto2',
      product_id: SOLIDGATE_PRODUCT_CODES.addon,
      product_slug: 'oto2_addon_weekly',
      amount_cents: 0,
      recurring_amount_cents: PRICE_MAP.oto2_addon_weekly.lt.amountCents,
      currency: 'EUR',
    });
  });

  it('builds one stable purchase ID from the merchant order ID', () => {
    expect(purchaseEventId('session:oto3_bundle_all:1')).toBe(
      'purchase:session:oto3_bundle_all:1',
    );
    expect(lifecycleEventId('oto3_purchased', 'session:oto3_bundle_all:1')).toBe(
      'oto3_purchased:session:oto3_bundle_all:1',
    );
  });
});
