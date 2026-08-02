// Contract tests for the special-offer subscription products.
//
// The funnel ships two abandonment-recovery / special-offer entry points:
//   - special_1eur  — a fixed low intro fee (e.g. $1) for the 7-day trial,
//                     then the trial_monthly rebill.
//   - special_free  — a 0 intro (free trial), card saved, trial_monthly
//                     rebill on day 8.
//
// Source of truth: packages/shared/src/price-map.ts. This file locks the
// per-locale pricing shape these two products must expose.

import { describe, it, expect } from 'vitest';
import { routing } from '@repo/i18n/routing';
import {
  PRICE_MAP,
  LOCALE_CURRENCY_MAP,
  resolveProductPrice,
  type Locale,
} from '../price-map';

const ALL_LOCALES = routing.locales as readonly Locale[];

describe('special-offer products are present in PRICE_MAP', () => {
  it('exposes special_1eur and special_free', () => {
    expect(PRICE_MAP.special_1eur).toBeDefined();
    expect(PRICE_MAP.special_free).toBeDefined();
  });

  it('both special-offer products cover all 15 locales', () => {
    for (const product of ['special_1eur', 'special_free'] as const) {
      expect(Object.keys(PRICE_MAP[product]).sort()).toEqual(
        [...ALL_LOCALES].sort(),
      );
    }
  });
});

describe('special_1eur — fixed low intro fee', () => {
  it('charges a strictly positive intro fee in every locale', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_1eur[locale].amountCents).toBeGreaterThan(0);
    }
  });

  it('intro fee is below the trial_monthly rebill price in every locale', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_1eur[locale].amountCents).toBeLessThan(
        PRICE_MAP.trial_monthly[locale].amountCents,
      );
    }
  });

  it('carries a marketing compareAtCents anchor above the intro fee', () => {
    for (const locale of ALL_LOCALES) {
      const entry = PRICE_MAP.special_1eur[locale];
      expect(entry.compareAtCents).toBeGreaterThan(0);
      expect(entry.amountCents).toBeLessThan(entry.compareAtCents as number);
    }
  });

  it('locks the headline intro amounts (en=$1, sk/lt/ru/lv/el/hr=€1)', () => {
    expect(PRICE_MAP.special_1eur.en.amountCents).toBe(100);
    for (const eurLocale of ['sk', 'lt', 'ru', 'lv', 'el', 'hr'] as const) {
      expect(PRICE_MAP.special_1eur[eurLocale].amountCents).toBe(100);
    }
  });

  it('resolveProductPrice returns currency + company code per locale', () => {
    const en = resolveProductPrice('special_1eur', 'en');
    expect(en).toMatchObject({
      amountCents: 100,
      currency: 'usd',
      productName: 'EN_BRAND_000000_SUB',
    });
    const cs = resolveProductPrice('special_1eur', 'cs');
    expect(cs.currency).toBe('czk');
    expect(cs.productName).toBe('CZ_BRAND_000000_SUB');
  });
});

describe('special_free — zero-amount intro variant', () => {
  it('charges nothing at checkout in all 15 locales', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].amountCents).toBe(0);
    }
  });

  it('still rebills at trial_monthly like every other intro tier', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.trial_monthly[locale].amountCents).toBeGreaterThan(
        PRICE_MAP.special_free[locale].amountCents,
      );
    }
  });

  it('still exposes a non-empty productName for every locale', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].productName).toMatch(/\S/);
    }
  });

  it('keeps a marketing compareAtCents anchor even though the trial is free', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].compareAtCents).toBeGreaterThan(0);
    }
  });

  it('resolveProductPrice returns a zero amount with the locale-correct currency', () => {
    for (const locale of ALL_LOCALES) {
      const resolved = resolveProductPrice('special_free', locale);
      expect(resolved.amountCents).toBe(0);
      expect(resolved.currency).toBe(LOCALE_CURRENCY_MAP[locale]);
    }
  });

  it('uses the same per-locale company code as the paid trial tiers', () => {
    // special_free is the same subscription offering, just with a 0 intro —
    // the company code must match trial1 so webhook/order attribution lines up.
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].productName).toBe(
        PRICE_MAP.trial1[locale].productName,
      );
    }
  });
});
