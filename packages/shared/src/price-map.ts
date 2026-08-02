// ─── Server-side Price Map (authoritative, locale-keyed) ─────────────────────
// Client cannot influence charge amounts. Server looks up amountCents +
// productName by (productId, locale) and forwards them to the PSP.
//
// Shape:
//   PRICE_MAP[productId][locale] → { amountCents, productName, compareAtCents? }
//
// The funnel offering set (rename the ids for your product, keep the grammar):
//   trial1..trial4      - one-time intro fees for the 4 tiers shown on /offer
//   special_1eur        - discounted intro used by the special-offer path
//   special_free        - free (zero-amount) intro, same offering as trial1
//   trial_monthly       - the recurring rebill the intro converts into
//   oto1_lifetime …     - the 8 OTO / upsell offerings
//
// productName is the PER-LOCALE company code the data pipeline and the webhooks
// match on. It is GENERATED, never hand-written:
//
//   {LOCALE_PREFIX}_{PRODUCT_CODE_PREFIX}{TOKEN}_{PRICE_BATCH}_{SUB|PDF}
//   e.g. EN_BRAND_000000_SUB, CZ_BRANDLIFETIME_000000_SUB, JP_BRANDPDF4_000000_PDF
//
// Generating it means "add a locale" is one line in LOCALE_COMPANY_PREFIXES and
// "rename the product" is one token below — instead of 255 literals that drift.
// PRICE_BATCH is shared with solidgate/catalog.ts: there is exactly ONE batch.
//
// TODO(new product): replace the demo amounts, the tokens and PRODUCT_CODE_PREFIX.

import type { Locale } from '@repo/i18n/routing';
import { LOCALE_COMPANY_PREFIXES } from './locale-prefixes';
export type { Locale };

// ─── Types ───────────────────────────────────────────────────────────────────

export type Currency =
  | 'eur'
  | 'czk'
  | 'twd'
  | 'usd'
  | 'huf'
  | 'ron'
  | 'ils'
  | 'pln'
  | 'dkk'
  | 'jpy';

export interface PriceEntry {
  readonly amountCents: number;
  readonly productName: string;
  readonly compareAtCents?: number;
}

export interface ResolvedPrice {
  readonly amountCents: number;
  readonly currency: Currency;
  readonly productName: string;
  readonly compareAtCents?: number;
}

// ─── Product code grammar ────────────────────────────────────────────────────

/** Brand segment of every product code. TODO(new product): rename. */
export const PRODUCT_CODE_PREFIX = 'BRAND';

/**
 * Catalog batch. Bumped when a whole price grid is re-issued at the PSP (old
 * codes must stay resolvable, so the batch is part of the code rather than a
 * mutation of it). ONE constant, shared with solidgate/catalog.ts — the repo
 * this was extracted from carried two batch numbers that silently drifted.
 */
export const PRICE_BATCH = '000000';

// ─── LOCALE_CURRENCY_MAP ──────────────────────────────────────────────────────

export const LOCALE_CURRENCY_MAP = {
  // EN charges in USD, but at the SAME 1:1 amounts as the EUR locales (no FX
  // conversion): every EN amountCents in PRICE_MAP equals its EUR-locale value,
  // so $19.00 == €19.00. Only EN mirrors EUR; all other locales are unchanged.
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
} as const satisfies Record<Locale, Currency>;

const ALL_LOCALES = Object.keys(LOCALE_CURRENCY_MAP) as Locale[];

/**
 * DEMO conversion factors applied to the EUR base amount, in MINOR units.
 *
 * One single fixed rate per currency, deliberately round so every derived
 * amount stays a clean demo number and every ordering invariant (trial1 <
 * trial2 < … < trial_monthly) survives the conversion untouched.
 *
 * Nominal demo rate: 1 EUR = 1 USD = 25 CZK = 400 HUF = 5 RON = 35 TWD =
 * 4 ILS = 4 PLN = 8 DKK = 200 JPY.
 *
 * JPY is ZERO-DECIMAL: its minor unit IS the yen, so the factor is
 * 200 / 100 = 2 — that is why it looks small next to the others. Never
 * multiply a JPY amount by 100.
 *
 * TODO(new product): replace with your real, priced-per-market grid. These
 * numbers are placeholders and must not be launched.
 */
const CURRENCY_DEMO_FACTORS: Record<Currency, number> = {
  eur: 1,
  usd: 1,
  czk: 25,
  huf: 400,
  ron: 5,
  twd: 35,
  ils: 4,
  pln: 4,
  dkk: 8,
  jpy: 2,
};

// ─── Product specs (the only place a product is declared) ────────────────────

interface ProductSpec {
  /** Code token appended to PRODUCT_CODE_PREFIX. '' for the main offering. */
  readonly token: string;
  /** Code suffix: SUB for subscriptions, PDF for one-time digital goods. */
  readonly kind: 'SUB' | 'PDF';
  /** Base amount in EUR minor units; every other currency derives from it. */
  readonly eurCents: number;
  /** Marketing "was" anchor in EUR minor units. Intro tiers only. */
  readonly compareAtEurCents?: number;
}

const PRODUCT_SPECS = {
  // Main subscription offering — one offering code, four intro price points.
  trial1: { token: '', kind: 'SUB', eurCents: 500, compareAtEurCents: 5900 },
  trial2: { token: '', kind: 'SUB', eurCents: 900, compareAtEurCents: 5900 },
  trial3: { token: '', kind: 'SUB', eurCents: 1300, compareAtEurCents: 5900 },
  trial4: { token: '', kind: 'SUB', eurCents: 1700, compareAtEurCents: 5900 },
  special_1eur: { token: '', kind: 'SUB', eurCents: 100, compareAtEurCents: 5900 },
  // Free intro: zero amount, but the SAME per-locale company code as trial1 so
  // the webhook attributes the resulting subscription to the same offering.
  special_free: { token: '', kind: 'SUB', eurCents: 0, compareAtEurCents: 5900 },
  // The recurring price every intro tier converts into.
  trial_monthly: { token: '', kind: 'SUB', eurCents: 5900 },

  // OTO / upsell offerings.
  oto1_lifetime: { token: 'LIFETIME', kind: 'SUB', eurCents: 9900 },
  oto2_addon_weekly: { token: 'ADDON', kind: 'SUB', eurCents: 1900 },
  oto3_bundle_all: { token: 'BUNDLE', kind: 'PDF', eurCents: 4900 },
  oto3_bundle_1: { token: 'BUNDLE1', kind: 'PDF', eurCents: 2900 },
  oto3_bundle_2: { token: 'BUNDLE2', kind: 'PDF', eurCents: 2900 },
  oto3_bundle_3: { token: 'BUNDLE3', kind: 'PDF', eurCents: 2900 },
  oto4_pdf: { token: 'PDF4', kind: 'PDF', eurCents: 1900 },
  oto5_pdf: { token: 'PDF5', kind: 'PDF', eurCents: 1900 },
  oto6_pdf: { token: 'PDF6', kind: 'PDF', eurCents: 1900 },
  oto7_pdf: { token: 'PDF7', kind: 'PDF', eurCents: 1900 },
} as const satisfies Record<string, ProductSpec>;

export type ProductId = keyof typeof PRODUCT_SPECS;
export type SellableProductId = ProductId;

/** The per-locale company code written to orders.product_name. */
export function productCompanyCode(productId: ProductId, locale: Locale): string {
  const { token, kind } = PRODUCT_SPECS[productId];
  const prefix = LOCALE_COMPANY_PREFIXES[locale];
  return `${prefix}_${PRODUCT_CODE_PREFIX}${token}_${PRICE_BATCH}_${kind}`;
}

// ─── PRICE_MAP ────────────────────────────────────────────────────────────────

function buildPriceMap(): Record<ProductId, Record<Locale, PriceEntry>> {
  const map = {} as Record<ProductId, Record<Locale, PriceEntry>>;
  for (const productId of Object.keys(PRODUCT_SPECS) as ProductId[]) {
    const spec: ProductSpec = PRODUCT_SPECS[productId];
    const byLocale = {} as Record<Locale, PriceEntry>;
    for (const locale of ALL_LOCALES) {
      const factor = CURRENCY_DEMO_FACTORS[LOCALE_CURRENCY_MAP[locale]];
      byLocale[locale] = {
        amountCents: spec.eurCents * factor,
        productName: productCompanyCode(productId, locale),
        // Omitted (not set to undefined) when the product has no anchor: OTO
        // products must not declare the key at all.
        ...(spec.compareAtEurCents !== undefined && {
          compareAtCents: spec.compareAtEurCents * factor,
        }),
      };
    }
    map[productId] = byLocale;
  }
  return map;
}

export const PRICE_MAP: Record<ProductId, Record<Locale, PriceEntry>> = buildPriceMap();

// ─── ZERO_DECIMAL_CURRENCIES ──────────────────────────────────────────────────

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
}

// ─── resolveProductPrice ─────────────────────────────────────────────────────

export function resolveProductPrice(
  productId: ProductId,
  locale: Locale,
): ResolvedPrice {
  const entry: PriceEntry = PRICE_MAP[productId][locale];
  return {
    amountCents: entry.amountCents,
    currency: LOCALE_CURRENCY_MAP[locale],
    productName: entry.productName,
    ...(entry.compareAtCents !== undefined && { compareAtCents: entry.compareAtCents }),
  };
}
