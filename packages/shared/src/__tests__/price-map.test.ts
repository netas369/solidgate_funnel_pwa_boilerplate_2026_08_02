// Contract tests for the server-side price map.
//
// Source of truth: packages/shared/src/price-map.ts. The map drives every
// charge amount/currency, so these tests lock:
//   - the full offering catalog (7 subscription products + 10 OTO products)
//   - every product covers all 15 routing locales
//   - resolveProductPrice() resolves amount + currency + productName per locale
//   - the generated company-code grammar
//   - LOCALE_CURRENCY_MAP / ZERO_DECIMAL_CURRENCIES invariants

import { describe, it, expect } from 'vitest';
import { routing } from '@repo/i18n/routing';
import {
  PRICE_MAP,
  PRICE_BATCH,
  PRODUCT_CODE_PREFIX,
  LOCALE_CURRENCY_MAP,
  ZERO_DECIMAL_CURRENCIES,
  isZeroDecimalCurrency,
  resolveProductPrice,
  type ProductId,
  type Currency,
  type Locale,
} from '../price-map';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// The 15 locales the funnel ships, per @repo/i18n routing.
const ALL_LOCALES = routing.locales as readonly Locale[];

// Current catalog. Subscription products carry compareAtCents; OTO products do
// not. `special_free` is the only zero-amount product.
const SUBSCRIPTION_PRODUCTS: readonly ProductId[] = [
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'trial_monthly',
  'special_1eur',
  'special_free',
];

const OTO_PRODUCTS: readonly ProductId[] = [
  'oto1_lifetime',
  'oto2_addon_weekly',
  'oto3_bundle_all',
  'oto3_bundle_1',
  'oto3_bundle_2',
  'oto3_bundle_3',
  'oto4_pdf',
  'oto5_pdf',
  'oto6_pdf',
  'oto7_pdf',
];

const ALL_PRODUCTS: readonly ProductId[] = [
  ...SUBSCRIPTION_PRODUCTS,
  ...OTO_PRODUCTS,
];

// Products expected to have a positive amount in every locale. `special_free`
// is 0 by design (free intro), so it is excluded from positive-amount checks.
const FREE_PRODUCTS: readonly ProductId[] = ['special_free'];
const PAID_PRODUCTS = ALL_PRODUCTS.filter(
  (p) => !FREE_PRODUCTS.includes(p),
) as readonly ProductId[];

const INTRO_TIERS: readonly ProductId[] = [
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
];

// ═════════════════════════════════════════════════════════════════════════════
// PRICE_MAP completeness
// ═════════════════════════════════════════════════════════════════════════════

describe('PRICE_MAP completeness', () => {
  it('contains exactly the 17 current products (7 subscription + 10 OTO)', () => {
    expect(Object.keys(PRICE_MAP).sort()).toEqual([...ALL_PRODUCTS].sort());
  });

  it('every product covers all 15 routing locales', () => {
    for (const product of ALL_PRODUCTS) {
      const localesForProduct = Object.keys(PRICE_MAP[product]).sort();
      expect(localesForProduct).toEqual([...ALL_LOCALES].sort());
    }
  });

  it.each(ALL_PRODUCTS)(
    'product %s has integer amountCents and non-empty productName for every locale',
    (product) => {
      for (const locale of ALL_LOCALES) {
        const entry = PRICE_MAP[product][locale];
        expect(entry).toBeDefined();
        expect(Number.isInteger(entry.amountCents)).toBe(true);
        expect(entry.amountCents).toBeGreaterThanOrEqual(0);
        expect(entry.productName.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(PAID_PRODUCTS)(
    'paid product %s has a strictly positive amountCents in every locale',
    (product) => {
      for (const locale of ALL_LOCALES) {
        expect(PRICE_MAP[product][locale].amountCents).toBeGreaterThan(0);
      }
    },
  );

  it('special_free is the ONLY zero-amount product, in every locale', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].amountCents).toBe(0);
    }
    for (const product of PAID_PRODUCTS) {
      for (const locale of ALL_LOCALES) {
        expect(PRICE_MAP[product][locale].amountCents).not.toBe(0);
      }
    }
  });

  it('special_free still carries a non-empty productName + compareAtCents per locale', () => {
    for (const locale of ALL_LOCALES) {
      const entry = PRICE_MAP.special_free[locale];
      expect(entry.productName.length).toBeGreaterThan(0);
      // compareAtCents is the marketing "was" price even when the intro is free.
      expect(entry.compareAtCents).toBeGreaterThan(0);
    }
  });

  it('special_free shares trial1 company code so webhook attribution lines up', () => {
    for (const locale of ALL_LOCALES) {
      expect(PRICE_MAP.special_free[locale].productName).toBe(
        PRICE_MAP.trial1[locale].productName,
      );
    }
  });

  it('intro-fee trial tiers carry a compareAtCents anchor in every locale', () => {
    for (const product of INTRO_TIERS) {
      for (const locale of ALL_LOCALES) {
        const entry = PRICE_MAP[product][locale];
        if (!('compareAtCents' in entry)) {
          throw new Error(`${product}/${locale} is missing compareAtCents`);
        }
        expect(entry.compareAtCents).toBeGreaterThan(0);
        // The discounted intro fee is below the marketing anchor.
        expect(entry.amountCents).toBeLessThan(entry.compareAtCents!);
      }
    }
  });

  it('OTO products do not declare a compareAtCents anchor', () => {
    for (const product of OTO_PRODUCTS) {
      for (const locale of ALL_LOCALES) {
        const entry = PRICE_MAP[product][locale];
        expect('compareAtCents' in entry ? entry.compareAtCents : undefined).toBeUndefined();
      }
    }
  });

  it('trial tiers escalate monotonically (trial1 < trial2 < trial3 < trial4) per locale', () => {
    for (const locale of ALL_LOCALES) {
      const t1 = PRICE_MAP.trial1[locale].amountCents;
      const t2 = PRICE_MAP.trial2[locale].amountCents;
      const t3 = PRICE_MAP.trial3[locale].amountCents;
      const t4 = PRICE_MAP.trial4[locale].amountCents;
      expect(t1).toBeLessThan(t2);
      expect(t2).toBeLessThan(t3);
      expect(t3).toBeLessThan(t4);
    }
  });

  it('every trial intro fee is below the trial_monthly rebill price per locale', () => {
    for (const product of [...INTRO_TIERS, 'special_free' as ProductId]) {
      for (const locale of ALL_LOCALES) {
        expect(PRICE_MAP[product][locale].amountCents).toBeLessThan(
          PRICE_MAP.trial_monthly[locale].amountCents,
        );
      }
    }
  });

  it('locks representative EN prices (subscription tiers)', () => {
    // EN mirrors the EUR locale amounts 1:1 (charged in USD, no FX conversion).
    expect(PRICE_MAP.trial1.en.amountCents).toBe(500);
    expect(PRICE_MAP.trial2.en.amountCents).toBe(900);
    expect(PRICE_MAP.trial3.en.amountCents).toBe(1300);
    expect(PRICE_MAP.trial4.en.amountCents).toBe(1700);
    expect(PRICE_MAP.special_1eur.en.amountCents).toBe(100);
    expect(PRICE_MAP.special_free.en.amountCents).toBe(0);
    expect(PRICE_MAP.trial_monthly.en.amountCents).toBe(5900);
  });

  it('locks representative EN prices (OTO products)', () => {
    expect(PRICE_MAP.oto1_lifetime.en.amountCents).toBe(9900);
    expect(PRICE_MAP.oto2_addon_weekly.en.amountCents).toBe(1900);
    expect(PRICE_MAP.oto3_bundle_all.en.amountCents).toBe(4900);
    expect(PRICE_MAP.oto7_pdf.en.amountCents).toBe(1900);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Generated company-code grammar
// ═════════════════════════════════════════════════════════════════════════════

describe('productName grammar', () => {
  // Self-maintaining: derived from the exported constants, so renaming the
  // brand prefix or bumping the batch cannot leave a stale literal behind.
  const GRAMMAR = new RegExp(
    `^[A-Z]{2}_${PRODUCT_CODE_PREFIX}[A-Z0-9]*_${PRICE_BATCH}_(SUB|PDF)$`,
  );

  it('every product × locale productName matches {PREFIX}_{CODE}{TOKEN}_{BATCH}_{KIND}', () => {
    for (const product of ALL_PRODUCTS) {
      for (const locale of ALL_LOCALES) {
        expect(
          PRICE_MAP[product][locale].productName,
          `${product}/${locale}`,
        ).toMatch(GRAMMAR);
      }
    }
  });

  it('every locale gets a DISTINCT code for the same product', () => {
    for (const product of ALL_PRODUCTS) {
      const names = ALL_LOCALES.map((l) => PRICE_MAP[product][l].productName);
      expect(new Set(names).size).toBe(ALL_LOCALES.length);
    }
  });

  it('all seven main-offering tiers share one code per locale', () => {
    for (const locale of ALL_LOCALES) {
      const names = new Set(
        SUBSCRIPTION_PRODUCTS.map((p) => PRICE_MAP[p][locale].productName),
      );
      expect(names.size, `locale ${locale}`).toBe(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LOCALE_CURRENCY_MAP
// ═════════════════════════════════════════════════════════════════════════════

describe('LOCALE_CURRENCY_MAP', () => {
  it('covers every routing locale', () => {
    for (const locale of ALL_LOCALES) {
      expect(LOCALE_CURRENCY_MAP[locale]).toBeDefined();
    }
  });

  it('maps each locale to its expected currency', () => {
    const expected: Record<Locale, Currency> = {
      en: 'usd',
      cs: 'czk',
      hu: 'huf',
      sk: 'eur',
      ro: 'ron',
      lt: 'eur',
      ru: 'eur',
      lv: 'eur',
      'zh-TW': 'twd',
      el: 'eur',
      he: 'ils',
      pl: 'pln',
      hr: 'eur',
      da: 'dkk',
      ja: 'jpy',
    };
    for (const locale of ALL_LOCALES) {
      expect(LOCALE_CURRENCY_MAP[locale]).toBe(expected[locale]);
    }
  });

  it('groups sk/lt/ru/lv/el/hr onto the shared eur currency', () => {
    for (const eurLocale of ['sk', 'lt', 'ru', 'lv', 'el', 'hr'] as const) {
      expect(LOCALE_CURRENCY_MAP[eurLocale]).toBe('eur');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ZERO_DECIMAL_CURRENCIES
// ═════════════════════════════════════════════════════════════════════════════

describe('ZERO_DECIMAL_CURRENCIES', () => {
  it('contains the 16 zero-decimal currencies', () => {
    const expected = [
      'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
      'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
    ];
    expect(ZERO_DECIMAL_CURRENCIES.size).toBe(16);
    for (const currency of expected) {
      expect(ZERO_DECIMAL_CURRENCIES.has(currency)).toBe(true);
    }
  });

  it('does NOT classify any other currency used by the funnel as zero-decimal', () => {
    // TWD/HUF look "whole-number-ish" but are decimal currencies.
    for (const currency of ['usd', 'eur', 'czk', 'huf', 'ron', 'twd', 'ils', 'pln', 'dkk']) {
      expect(ZERO_DECIMAL_CURRENCIES.has(currency)).toBe(false);
    }
  });

  it('isZeroDecimalCurrency is case-insensitive', () => {
    expect(isZeroDecimalCurrency('JPY')).toBe(true);
    expect(isZeroDecimalCurrency('jpy')).toBe(true);
    expect(isZeroDecimalCurrency('EUR')).toBe(false);
    expect(isZeroDecimalCurrency('TWD')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveProductPrice
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveProductPrice', () => {
  it('resolves amount + currency + productName for every product × locale', () => {
    for (const product of ALL_PRODUCTS) {
      for (const locale of ALL_LOCALES) {
        const resolved = resolveProductPrice(product, locale);
        const entry = PRICE_MAP[product][locale];
        expect(resolved.amountCents).toBe(entry.amountCents);
        expect(resolved.currency).toBe(LOCALE_CURRENCY_MAP[locale]);
        expect(resolved.productName).toBe(entry.productName);
      }
    }
  });

  it('resolves trial1 en → USD / 500 cents / EN company code', () => {
    const result = resolveProductPrice('trial1', 'en');
    expect(result).toMatchObject({
      amountCents: 500,
      currency: 'usd',
      productName: 'EN_BRAND_000000_SUB',
    });
  });

  it('resolves trial4 cs → CZK with the Czech company code', () => {
    const result = resolveProductPrice('trial4', 'cs');
    expect(result.currency).toBe('czk');
    expect(result.amountCents).toBe(42500);
    expect(result.productName).toBe('CZ_BRAND_000000_SUB');
  });

  it('resolves oto1_lifetime zh-TW → TWD (decimal currency) with the TW company code', () => {
    const result = resolveProductPrice('oto1_lifetime', 'zh-TW');
    expect(result.currency).toBe('twd');
    expect(ZERO_DECIMAL_CURRENCIES.has(result.currency)).toBe(false);
    expect(result.amountCents).toBe(346500);
    expect(result.productName).toBe('TW_BRANDLIFETIME_000000_SUB');
  });

  it('resolves ja → whole yen, never x100', () => {
    expect(resolveProductPrice('trial_monthly', 'ja')).toMatchObject({
      currency: 'jpy',
      amountCents: 11800,
      productName: 'JP_BRAND_000000_SUB',
    });
    expect(isZeroDecimalCurrency(resolveProductPrice('trial1', 'ja').currency)).toBe(true);
  });

  it('resolves special_free → 0 in every locale with the resolved currency', () => {
    for (const locale of ALL_LOCALES) {
      const result = resolveProductPrice('special_free', locale);
      expect(result.amountCents).toBe(0);
      expect(result.currency).toBe(LOCALE_CURRENCY_MAP[locale]);
    }
  });

  it('forwards compareAtCents when the entry declares one, omits it otherwise', () => {
    // trial1 declares a compareAtCents anchor.
    const trial = resolveProductPrice('trial1', 'en');
    expect(trial.compareAtCents).toBe(PRICE_MAP.trial1.en.compareAtCents);
    // OTO products do not.
    const oto = resolveProductPrice('oto1_lifetime', 'en');
    expect(oto.compareAtCents).toBeUndefined();
  });

  it('shares the EUR currency for all eur-grouped locales (sk/lt/ru/lv/el/hr)', () => {
    for (const eurLocale of ['sk', 'lt', 'ru', 'lv', 'el', 'hr'] as const) {
      expect(resolveProductPrice('oto2_addon_weekly', eurLocale).currency).toBe('eur');
    }
  });

  it('returns distinct per-locale company codes for the same product', () => {
    const en = resolveProductPrice('oto3_bundle_all', 'en');
    const cs = resolveProductPrice('oto3_bundle_all', 'cs');
    expect(en.productName).not.toBe(cs.productName);
    expect(en.productName).toBe('EN_BRANDBUNDLE_000000_PDF');
    expect(cs.productName).toBe('CZ_BRANDBUNDLE_000000_PDF');
  });
});
