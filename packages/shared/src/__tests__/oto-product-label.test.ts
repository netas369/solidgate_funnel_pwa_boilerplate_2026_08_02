// Contract tests for productKeyFromSlug — the OTO-8 summary resolver that maps
// an `orders.product_slug` value (either internal id or locale-coded company
// code) onto a stable display key.

import { describe, it, expect } from 'vitest';
import { PRICE_MAP } from '../price-map';
import { PRODUCT_ID_TO_CODE } from '../solidgate/catalog';
import { productKeyFromSlug, type ProductKey } from '../oto-product-label';

describe('productKeyFromSlug', () => {
  it('maps internal friendly ids to keys', () => {
    expect(productKeyFromSlug('trial3')).toBe('subscription');
    expect(productKeyFromSlug('special_1eur')).toBe('subscription');
    expect(productKeyFromSlug('trial_monthly')).toBe('subscription');
    expect(productKeyFromSlug('oto1_lifetime')).toBe('lifetime');
    expect(productKeyFromSlug('oto2_addon_weekly')).toBe('addon');
    expect(productKeyFromSlug('oto3_bundle_all')).toBe('bundleAll');
    expect(productKeyFromSlug('oto3_bundle_2')).toBe('bundle2');
    expect(productKeyFromSlug('oto7_pdf')).toBe('pdf7');
  });

  it('maps locale-coded company codes to keys via the product token', () => {
    expect(productKeyFromSlug('EN_BRAND_000000_SUB')).toBe('subscription');
    expect(productKeyFromSlug('CZ_BRANDLIFETIME_000000_SUB')).toBe('lifetime');
    expect(productKeyFromSlug('LV_BRANDPDF7_000000_PDF')).toBe('pdf7');
    expect(productKeyFromSlug('HU_BRANDBUNDLE1_000000_PDF')).toBe('bundle1');
  });

  // parts[0] vs parts[1]: reading only parts[1] made every locale-agnostic
  // (PSP-issued) code resolve to 'unknown' and blanked the OTO-8 summary.
  it('maps locale-AGNOSTIC company codes too (token at parts[0])', () => {
    expect(productKeyFromSlug('BRAND_000000_SUB')).toBe('subscription');
    expect(productKeyFromSlug('BRANDADDON_000000_SUB')).toBe('addon');
    expect(productKeyFromSlug('BRANDPDF4_000000_PDF')).toBe('pdf4');
  });

  it('returns "unknown" for null/empty/unrecognised slugs', () => {
    expect(productKeyFromSlug(null)).toBe('unknown');
    expect(productKeyFromSlug(undefined)).toBe('unknown');
    expect(productKeyFromSlug('')).toBe('unknown');
    expect(productKeyFromSlug('something_else_entirely')).toBe('unknown');
  });

  it('resolves every PRICE_MAP product id to a non-unknown key', () => {
    for (const id of Object.keys(PRICE_MAP)) {
      const key: ProductKey = productKeyFromSlug(id);
      expect(key, `internal id "${id}" should resolve`).not.toBe('unknown');
    }
  });

  it('resolves every PRICE_MAP company code to a non-unknown key', () => {
    for (const product of Object.values(PRICE_MAP)) {
      for (const entry of Object.values(product)) {
        const slug = entry.productName;
        const key: ProductKey = productKeyFromSlug(slug);
        expect(key, `company code "${slug}" should resolve`).not.toBe('unknown');
      }
    }
  });

  it('resolves every locale-agnostic catalog code to a non-unknown key', () => {
    for (const [productId, code] of Object.entries(PRODUCT_ID_TO_CODE)) {
      const key: ProductKey = productKeyFromSlug(code);
      expect(key, `catalog code "${code}" (${productId}) should resolve`).not.toBe('unknown');
      // Both conventions for the same product must land on the SAME key, or the
      // OTO-8 summary would label the same purchase two different ways.
      expect(key, productId).toBe(productKeyFromSlug(productId));
    }
  });
});
