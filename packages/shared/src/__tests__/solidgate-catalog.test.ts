import { describe, expect, it } from 'vitest';
import { routing } from '@repo/i18n/routing';
import {
  PRICE_MAP,
  LOCALE_CURRENCY_MAP,
  PRICE_BATCH,
  PRODUCT_CODE_PREFIX,
  type ProductId,
  type Locale,
} from '../price-map';
import {
  ADDON_TRIAL_INTRO_AMOUNTS,
  CATALOG_AMOUNTS,
  CATALOG_CURRENCIES,
  ONE_TIME_PRODUCT_IDS,
  PRODUCT_ID_TO_CODE,
  SOLIDGATE_BATCH,
  SOLIDGATE_PRODUCTS,
} from '../solidgate/catalog';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read from DISK rather than importing: the "ships unseeded" guard below must
// assert on what is actually committed, not on a bundler-transformed copy.
const catalogIds = JSON.parse(
  readFileSync(join(__dirname, '../solidgate/catalog-ids.json'), 'utf8'),
) as Record<string, { product_id: string; prices: Record<string, string> }>;

const productIds = Object.keys(PRICE_MAP) as ProductId[];

describe('solidgate catalog ↔ price map', () => {
  // The whole single-product model rests on this: if two locales sharing a
  // currency ever disagree on an amount, one price per currency is impossible.
  it('every locale sharing a currency shares the amount', () => {
    for (const productId of productIds) {
      const seen = new Map<string, { amount: number; locale: string }>();
      for (const locale of routing.locales as readonly Locale[]) {
        const currency = LOCALE_CURRENCY_MAP[locale];
        const { amountCents } = PRICE_MAP[productId][locale];
        const prev = seen.get(currency);
        if (prev) {
          expect(
            amountCents,
            `${productId}/${currency}: ${locale}=${amountCents} vs ${prev.locale}=${prev.amount}`,
          ).toBe(prev.amount);
        } else {
          seen.set(currency, { amount: amountCents, locale });
        }
      }
    }
  });

  it('catalog amounts equal the price map for every product × currency', () => {
    for (const productId of productIds) {
      for (const locale of routing.locales as readonly Locale[]) {
        const currency = LOCALE_CURRENCY_MAP[locale];
        expect(
          CATALOG_AMOUNTS[productId][currency],
          `${productId}/${currency} (via ${locale})`,
        ).toBe(PRICE_MAP[productId][locale].amountCents);
      }
    }
  });

  it('covers every product and every currency, with no placeholder gaps', () => {
    expect(Object.keys(CATALOG_AMOUNTS).sort()).toEqual([...productIds].sort());
    for (const productId of productIds) {
      for (const currency of CATALOG_CURRENCIES) {
        const amount = CATALOG_AMOUNTS[productId][currency];
        expect(Number.isInteger(amount), `${productId}/${currency} not an integer`).toBe(true);
        // special_free is the only legitimately zero offering.
        if (productId !== 'special_free') {
          expect(amount, `${productId}/${currency} is zero`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('JPY amounts are whole yen (zero-decimal), never x100', () => {
    // A JPY amount accidentally multiplied by 100 would overcharge 100x.
    expect(CATALOG_AMOUNTS.trial_monthly.jpy).toBe(11800);
    expect(CATALOG_AMOUNTS.trial1.jpy).toBe(1000);
    expect(CATALOG_AMOUNTS.special_1eur.jpy).toBe(200);
  });

  it('EN (usd) is 1:1 with eur, per the equalisation decision', () => {
    for (const productId of productIds) {
      expect(CATALOG_AMOUNTS[productId].usd, `${productId}: usd != eur`).toBe(
        CATALOG_AMOUNTS[productId].eur,
      );
    }
  });
});

describe('solidgate product codes', () => {
  it('are locale-agnostic and carry the one shared batch', () => {
    // ONE batch constant, shared with price-map.ts. The repo this was extracted
    // from carried two that silently drifted apart.
    expect(SOLIDGATE_BATCH).toBe(PRICE_BATCH);
    // Derived from the exported constants, never re-typed, so a prefix or batch
    // rename cannot leave this regex behind.
    const CODE_GRAMMAR = new RegExp(
      `^${PRODUCT_CODE_PREFIX}[A-Z0-9]*_${PRICE_BATCH}_(SUB|PDF)$`,
    );
    for (const [productId, code] of Object.entries(PRODUCT_ID_TO_CODE)) {
      expect(code, `${productId} has a locale prefix`).toMatch(CODE_GRAMMAR);
    }
  });

  // The locale-agnostic catalog code is the locale-coded price-map code minus
  // the two-letter market prefix. If these two grammars ever diverge, the
  // webhook stops resolving orders to entitlements.
  it('are the price-map company code without the locale prefix', () => {
    for (const productId of productIds) {
      const localeCoded = PRICE_MAP[productId].en.productName;
      expect(localeCoded, productId).toBe(`EN_${PRODUCT_ID_TO_CODE[productId]}`);
    }
  });

  it('maps every product id to a code', () => {
    expect(Object.keys(PRODUCT_ID_TO_CODE).sort()).toEqual([...productIds].sort());
  });
});

describe('solidgate product definitions', () => {
  it('gives the 5 paid tiers a paid 7-day trial priced at the intro amount', () => {
    for (const tier of ['trial1', 'trial2', 'trial3', 'trial4', 'special_1eur'] as const) {
      const def = SOLIDGATE_PRODUCTS.find((p) => p.key === tier);
      expect(def, `${tier} missing from SOLIDGATE_PRODUCTS`).toBeDefined();
      expect(def!.trial?.paymentAction).toBe('auth_settle');
      expect(def!.trial?.period).toEqual({ unit: 'day', value: 7 });
      expect(def!.trial?.amounts).toBe(CATALOG_AMOUNTS[tier]);
      // All main tiers rebill at the same monthly price.
      expect(def!.rebillAmounts).toBe(CATALOG_AMOUNTS.trial_monthly);
      expect(def!.billingPeriod).toEqual({ unit: 'day', value: 30 });
    }
  });

  it('gives special_free a free zero-amount trial, and carries no intro amounts', () => {
    const def = SOLIDGATE_PRODUCTS.find((p) => p.key === 'special_free')!;
    // auth_0_amount only tokenizes the card; sending trial amounts alongside it
    // would contradict the zero-amount auth.
    expect(def.trial?.paymentAction).toBe('auth_0_amount');
    expect(def.trial?.amounts).toBeUndefined();
    expect(def.trial?.period).toEqual({ unit: 'day', value: 7 });
    // The price map must agree that this tier charges nothing at checkout.
    for (const currency of CATALOG_CURRENCIES) {
      expect(CATALOG_AMOUNTS.special_free[currency], currency).toBe(0);
    }
    // It is still the same offering and still rebills at the monthly price.
    expect(def.productCode).toBe(PRODUCT_ID_TO_CODE.special_1eur);
    expect(def.rebillAmounts).toBe(CATALOG_AMOUNTS.trial_monthly);
  });

  it('bills the add-on weekly, with and without a trial (funnel OTO2 vs PWA paywall)', () => {
    const withTrial = SOLIDGATE_PRODUCTS.find((p) => p.key === 'addon_trial')!;
    const direct = SOLIDGATE_PRODUCTS.find((p) => p.key === 'addon_direct')!;
    expect(withTrial.billingPeriod).toEqual({ unit: 'week', value: 1 });
    expect(direct.billingPeriod).toEqual({ unit: 'week', value: 1 });
    expect(withTrial.trial?.paymentAction).toBe('auth_settle');
    expect(withTrial.trial?.amounts).toBe(ADDON_TRIAL_INTRO_AMOUNTS);
    // Same low intro as the main special tier, per currency.
    expect(ADDON_TRIAL_INTRO_AMOUNTS).toEqual(CATALOG_AMOUNTS.special_1eur);
    expect(direct.trial).toBeUndefined();
    // Same offering, so the same code lands in orders.product_slug either way.
    expect(withTrial.productCode).toBe(direct.productCode);
    expect(withTrial.rebillAmounts).toBe(CATALOG_AMOUNTS.oto2_addon_weekly);
    expect(direct.rebillAmounts).toBe(CATALOG_AMOUNTS.oto2_addon_weekly);
  });

  it('never turns a one-time OTO into a catalog product', () => {
    const catalogueKeys = new Set(SOLIDGATE_PRODUCTS.map((p) => p.key));
    for (const oneTime of ONE_TIME_PRODUCT_IDS) {
      expect(catalogueKeys.has(oneTime), `${oneTime} must not be a Solidgate product`).toBe(false);
    }
  });

  it('every catalog product key has a catalog-ids.json entry with all currencies', () => {
    // catalog-ids.json is what create-session/charge-oto index into. A key that
    // exists here but not there is a runtime 500 at checkout, not a type error.
    const keys = new Set(Object.keys(catalogIds));
    for (const def of SOLIDGATE_PRODUCTS) {
      expect(keys.has(def.key), `${def.key} missing from catalog-ids.json`).toBe(true);
      const entry = catalogIds[def.key];
      expect(Object.keys(entry.prices).sort()).toEqual([...CATALOG_CURRENCIES].sort());
    }
    expect(keys.size).toBe(SOLIDGATE_PRODUCTS.length);
  });

  it('ships catalog-ids.json UNSEEDED — no ids from anyone else\'s merchant account', () => {
    // Release blocker guard. Real Solidgate resource ids must never be
    // committed: the next product could otherwise charge against them.
    // Repopulate locally with `npx tsx scripts/solidgate-seed-catalog.ts --apply`.
    for (const [key, entry] of Object.entries(catalogIds)) {
      expect(entry.product_id, `${key}.product_id is seeded`).toBe('');
      for (const [currency, priceId] of Object.entries(entry.prices)) {
        expect(priceId, `${key}.prices.${currency} is seeded`).toBe('');
      }
    }
  });

  it('has a price in every catalog currency for every product', () => {
    for (const def of SOLIDGATE_PRODUCTS) {
      for (const currency of CATALOG_CURRENCIES) {
        expect(def.rebillAmounts[currency], `${def.key}/${currency} rebill`).toBeGreaterThan(0);
        if (def.trial?.amounts) {
          expect(def.trial.amounts[currency], `${def.key}/${currency} trial`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every auth_settle trial an amount and every auth_0_amount trial none', () => {
    for (const def of SOLIDGATE_PRODUCTS) {
      if (!def.trial) continue;
      if (def.trial.paymentAction === 'auth_settle') {
        expect(def.trial.amounts, `${def.key} paid trial without amounts`).toBeDefined();
      } else {
        expect(def.trial.amounts, `${def.key} free trial with amounts`).toBeUndefined();
      }
    }
  });
});
