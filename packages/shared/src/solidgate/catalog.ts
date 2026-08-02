// ─── Solidgate catalog (locale-agnostic, multi-currency) ─────────────────────
// ONE product per offering+tier, priced in every currency — replacing the older
// ~168 per-locale products this repo was extracted from. Locale never enters the
// catalog: it selects a CURRENCY (price-map.ts LOCALE_CURRENCY_MAP) and rides
// along in order_metadata.
//
// Amounts mirror PRICE_MAP, the single source of truth, and are pinned by
// __tests__/solidgate-catalog.test.ts — the two cannot drift. Keep BOTH tables
// literal: deriving one from the other would make that test tautological and
// remove the only guard against a half-finished rename.
//
// Product codes are the price-map grammar minus the locale prefix, on the same
// PRICE_BATCH: BRAND_000000_SUB, BRANDADDON_000000_SUB, BRANDPDF4_000000_PDF, …
//
// Only SUBSCRIPTIONS need catalog products (Solidgate reads billing period,
// trial, and price from the product). One-time OTOs carry no product at all:
// they are charged through POST /recurring with an explicit amount + currency.
//
// SEEDING: catalog-ids.json ships EMPTY in the boilerplate. Create the products
// in your own Solidgate merchant account and repopulate it with
//   npx tsx scripts/solidgate-seed-catalog.ts --apply
// Until then every catalog id is "" and checkout will fail loudly at the API,
// which is the intended behaviour — never ship a plausible-looking fake id.

import type { Currency, ProductId } from '../price-map';
import { PRICE_BATCH, PRODUCT_CODE_PREFIX } from '../price-map';

/** Shared with price-map.ts. There is exactly one batch constant. */
export const SOLIDGATE_BATCH = PRICE_BATCH;

/** Offering code written to orders.product_slug + order_metadata.product_code. */
export const SOLIDGATE_PRODUCT_CODES = {
  main: `${PRODUCT_CODE_PREFIX}_${SOLIDGATE_BATCH}_SUB`,
  addon: `${PRODUCT_CODE_PREFIX}ADDON_${SOLIDGATE_BATCH}_SUB`,
  lifetime: `${PRODUCT_CODE_PREFIX}LIFETIME_${SOLIDGATE_BATCH}_SUB`,
  bundleAll: `${PRODUCT_CODE_PREFIX}BUNDLE_${SOLIDGATE_BATCH}_PDF`,
  bundle1: `${PRODUCT_CODE_PREFIX}BUNDLE1_${SOLIDGATE_BATCH}_PDF`,
  bundle2: `${PRODUCT_CODE_PREFIX}BUNDLE2_${SOLIDGATE_BATCH}_PDF`,
  bundle3: `${PRODUCT_CODE_PREFIX}BUNDLE3_${SOLIDGATE_BATCH}_PDF`,
  pdf4: `${PRODUCT_CODE_PREFIX}PDF4_${SOLIDGATE_BATCH}_PDF`,
  pdf5: `${PRODUCT_CODE_PREFIX}PDF5_${SOLIDGATE_BATCH}_PDF`,
  pdf6: `${PRODUCT_CODE_PREFIX}PDF6_${SOLIDGATE_BATCH}_PDF`,
  pdf7: `${PRODUCT_CODE_PREFIX}PDF7_${SOLIDGATE_BATCH}_PDF`,
} as const;

/** Internal slug → offering code (what the webhook/entitlements match on). */
export const PRODUCT_ID_TO_CODE: Record<ProductId, string> = {
  trial1: SOLIDGATE_PRODUCT_CODES.main,
  trial2: SOLIDGATE_PRODUCT_CODES.main,
  trial3: SOLIDGATE_PRODUCT_CODES.main,
  trial4: SOLIDGATE_PRODUCT_CODES.main,
  special_1eur: SOLIDGATE_PRODUCT_CODES.main,
  special_free: SOLIDGATE_PRODUCT_CODES.main,
  trial_monthly: SOLIDGATE_PRODUCT_CODES.main,
  oto2_addon_weekly: SOLIDGATE_PRODUCT_CODES.addon,
  oto1_lifetime: SOLIDGATE_PRODUCT_CODES.lifetime,
  oto3_bundle_all: SOLIDGATE_PRODUCT_CODES.bundleAll,
  oto3_bundle_1: SOLIDGATE_PRODUCT_CODES.bundle1,
  oto3_bundle_2: SOLIDGATE_PRODUCT_CODES.bundle2,
  oto3_bundle_3: SOLIDGATE_PRODUCT_CODES.bundle3,
  oto4_pdf: SOLIDGATE_PRODUCT_CODES.pdf4,
  oto5_pdf: SOLIDGATE_PRODUCT_CODES.pdf5,
  oto6_pdf: SOLIDGATE_PRODUCT_CODES.pdf6,
  oto7_pdf: SOLIDGATE_PRODUCT_CODES.pdf7,
};

/** Stable, human-readable commerce names shared by browser/server analytics. */
export const PRODUCT_ID_TO_DISPLAY_NAME: Record<ProductId, string> = {
  trial1: 'Main Subscription',
  trial2: 'Main Subscription',
  trial3: 'Main Subscription',
  trial4: 'Main Subscription',
  special_1eur: 'Main Subscription',
  special_free: 'Main Subscription',
  trial_monthly: 'Main Subscription',
  oto1_lifetime: 'Lifetime Access',
  oto2_addon_weekly: 'Weekly Add-on',
  oto3_bundle_all: 'Bundle (all)',
  oto3_bundle_1: 'Bundle 1',
  oto3_bundle_2: 'Bundle 2',
  oto3_bundle_3: 'Bundle 3',
  oto4_pdf: 'Digital Product 4',
  oto5_pdf: 'Digital Product 5',
  oto6_pdf: 'Digital Product 6',
  oto7_pdf: 'Digital Product 7',
};

export type CurrencyAmounts = Readonly<Record<Currency, number>>;

/** Amounts per currency, mirrored from PRICE_MAP (minor units; JPY is whole yen). */
export const CATALOG_AMOUNTS = {
  trial1: {
    eur: 500,
    usd: 500,
    czk: 12500,
    huf: 200000,
    ron: 2500,
    twd: 17500,
    ils: 2000,
    pln: 2000,
    dkk: 4000,
    jpy: 1000,
  },
  trial2: {
    eur: 900,
    usd: 900,
    czk: 22500,
    huf: 360000,
    ron: 4500,
    twd: 31500,
    ils: 3600,
    pln: 3600,
    dkk: 7200,
    jpy: 1800,
  },
  trial3: {
    eur: 1300,
    usd: 1300,
    czk: 32500,
    huf: 520000,
    ron: 6500,
    twd: 45500,
    ils: 5200,
    pln: 5200,
    dkk: 10400,
    jpy: 2600,
  },
  trial4: {
    eur: 1700,
    usd: 1700,
    czk: 42500,
    huf: 680000,
    ron: 8500,
    twd: 59500,
    ils: 6800,
    pln: 6800,
    dkk: 13600,
    jpy: 3400,
  },
  special_1eur: {
    eur: 100,
    usd: 100,
    czk: 2500,
    huf: 40000,
    ron: 500,
    twd: 3500,
    ils: 400,
    pln: 400,
    dkk: 800,
    jpy: 200,
  },
  // The only legitimately zero offering: a FREE intro tokenized with
  // auth_0_amount. Note some acquirer channels reject zero-amount auths — if
  // yours does, price this tier like special_1eur and switch its product below
  // to auth_settle.
  special_free: {
    eur: 0,
    usd: 0,
    czk: 0,
    huf: 0,
    ron: 0,
    twd: 0,
    ils: 0,
    pln: 0,
    dkk: 0,
    jpy: 0,
  },
  trial_monthly: {
    eur: 5900,
    usd: 5900,
    czk: 147500,
    huf: 2360000,
    ron: 29500,
    twd: 206500,
    ils: 23600,
    pln: 23600,
    dkk: 47200,
    jpy: 11800,
  },
  oto2_addon_weekly: {
    eur: 1900,
    usd: 1900,
    czk: 47500,
    huf: 760000,
    ron: 9500,
    twd: 66500,
    ils: 7600,
    pln: 7600,
    dkk: 15200,
    jpy: 3800,
  },
  oto3_bundle_all: {
    eur: 4900,
    usd: 4900,
    czk: 122500,
    huf: 1960000,
    ron: 24500,
    twd: 171500,
    ils: 19600,
    pln: 19600,
    dkk: 39200,
    jpy: 9800,
  },
  oto3_bundle_1: {
    eur: 2900,
    usd: 2900,
    czk: 72500,
    huf: 1160000,
    ron: 14500,
    twd: 101500,
    ils: 11600,
    pln: 11600,
    dkk: 23200,
    jpy: 5800,
  },
  oto3_bundle_2: {
    eur: 2900,
    usd: 2900,
    czk: 72500,
    huf: 1160000,
    ron: 14500,
    twd: 101500,
    ils: 11600,
    pln: 11600,
    dkk: 23200,
    jpy: 5800,
  },
  oto3_bundle_3: {
    eur: 2900,
    usd: 2900,
    czk: 72500,
    huf: 1160000,
    ron: 14500,
    twd: 101500,
    ils: 11600,
    pln: 11600,
    dkk: 23200,
    jpy: 5800,
  },
  oto4_pdf: {
    eur: 1900,
    usd: 1900,
    czk: 47500,
    huf: 760000,
    ron: 9500,
    twd: 66500,
    ils: 7600,
    pln: 7600,
    dkk: 15200,
    jpy: 3800,
  },
  oto5_pdf: {
    eur: 1900,
    usd: 1900,
    czk: 47500,
    huf: 760000,
    ron: 9500,
    twd: 66500,
    ils: 7600,
    pln: 7600,
    dkk: 15200,
    jpy: 3800,
  },
  oto6_pdf: {
    eur: 1900,
    usd: 1900,
    czk: 47500,
    huf: 760000,
    ron: 9500,
    twd: 66500,
    ils: 7600,
    pln: 7600,
    dkk: 15200,
    jpy: 3800,
  },
  oto7_pdf: {
    eur: 1900,
    usd: 1900,
    czk: 47500,
    huf: 760000,
    ron: 9500,
    twd: 66500,
    ils: 7600,
    pln: 7600,
    dkk: 15200,
    jpy: 3800,
  },
  oto1_lifetime: {
    eur: 9900,
    usd: 9900,
    czk: 247500,
    huf: 3960000,
    ron: 49500,
    twd: 346500,
    ils: 39600,
    pln: 39600,
    dkk: 79200,
    jpy: 19800,
  },
} as const satisfies Record<ProductId, CurrencyAmounts>;

// ─── Products to create in Solidgate ────────────────────────────────────────
// Every catalog product bills recurringly. The 6 main-offer entries share ONE
// offering code and one rebill price (trial_monthly); they differ only in the
// intro amount charged during the 7-day trial — which is precisely Solidgate's
// price.trial_price. That is why an intro tier is a product here and would be
// merely an amount-on-a-PaymentIntent under a PSP that models trials on prices.
//
// payment_action semantics (Solidgate):
//   auth_settle    → PAID trial: charge trial_price now, rebill product_price later
//   auth_0_amount  → FREE trial: zero-amount auth now (tokenizes the card), rebill later

export interface SolidgateProductDef {
  /** Catalog key; also the tier written to order_metadata. */
  readonly key: string;
  readonly productCode: string;
  readonly displayName: string;
  /** Recurring price after the trial. */
  readonly rebillAmounts: CurrencyAmounts;
  readonly billingPeriod: { readonly unit: 'day' | 'week' | 'month' | 'year'; readonly value: number };
  readonly trial?: {
    readonly paymentAction: 'auth_settle' | 'auth_0_amount';
    readonly period: { readonly unit: 'day' | 'week' | 'month' | 'year'; readonly value: number };
    /** Only for auth_settle (paid) trials — the intro amount. */
    readonly amounts?: CurrencyAmounts;
  };
}

// The main plan bills every 30 DAYS, not per calendar month: every rendered
// disclosure ("your subscription will automatically continue at {price} every
// 30 days"), in every locale, promises exactly that — the catalog must match
// the copy, not the other way round. Change this, the checkout disclosure
// strings and features/checkout/lib/compliant-labels.ts together or not at all.
const EVERY_30_DAYS = { unit: 'day', value: 30 } as const;
const WEEKLY = { unit: 'week', value: 1 } as const;
const SEVEN_DAYS = { unit: 'day', value: 7 } as const;

/**
 * Intro amount settled when the add-on 7-day trial starts (funnel OTO2). The
 * charge route and the OTO2 page must quote exactly what Solidgate's
 * trial_price settles, per currency — so this table is exported rather than
 * re-derived at the call site.
 */
export const ADDON_TRIAL_INTRO_AMOUNTS: CurrencyAmounts = {
  eur: 100,
  usd: 100,
  czk: 2500,
  huf: 40000,
  ron: 500,
  twd: 3500,
  ils: 400,
  pln: 400,
  dkk: 800,
  jpy: 200,
};

export const SOLIDGATE_PRODUCTS: readonly SolidgateProductDef[] = [
  ...(['trial1', 'trial2', 'trial3', 'trial4', 'special_1eur'] as const).map((tier) => ({
    key: tier,
    productCode: SOLIDGATE_PRODUCT_CODES.main,
    displayName: `Main Subscription (${tier})`,
    rebillAmounts: CATALOG_AMOUNTS.trial_monthly,
    billingPeriod: EVERY_30_DAYS,
    trial: {
      paymentAction: 'auth_settle' as const,
      period: SEVEN_DAYS,
      amounts: CATALOG_AMOUNTS[tier],
    },
  })),
  {
    key: 'special_free',
    productCode: SOLIDGATE_PRODUCT_CODES.main,
    displayName: 'Main Subscription (special_free)',
    rebillAmounts: CATALOG_AMOUNTS.trial_monthly,
    billingPeriod: EVERY_30_DAYS,
    // Free trial: zero-amount auth tokenizes the card, first real charge is the
    // rebill. Some acquirer channels decline zero-amount auths (Solidgate code
    // 5.04) — if yours does, price special_free like special_1eur and switch
    // this to auth_settle with `amounts: CATALOG_AMOUNTS.special_free`.
    trial: {
      paymentAction: 'auth_0_amount' as const,
      period: SEVEN_DAYS,
    },
  },
  {
    // Funnel OTO2: 7-day paid trial on the card saved at checkout.
    key: 'addon_trial',
    productCode: SOLIDGATE_PRODUCT_CODES.addon,
    displayName: 'Weekly Add-on (7-day trial)',
    rebillAmounts: CATALOG_AMOUNTS.oto2_addon_weekly,
    billingPeriod: WEEKLY,
    trial: {
      paymentAction: 'auth_settle' as const,
      period: SEVEN_DAYS,
      amounts: ADDON_TRIAL_INTRO_AMOUNTS,
    },
  },
  {
    // PWA paywall: charges the first week immediately, no trial. A PSP that
    // models the trial on the PRICE expresses this as the same price minus
    // trial_period_days; Solidgate puts the trial on the PRODUCT, so the two
    // behaviours need two products (sharing one offering code).
    key: 'addon_direct',
    productCode: SOLIDGATE_PRODUCT_CODES.addon,
    displayName: 'Weekly Add-on',
    rebillAmounts: CATALOG_AMOUNTS.oto2_addon_weekly,
    billingPeriod: WEEKLY,
  },
];

/** One-time offerings: no catalog product — POST /recurring with these amounts. */
export const ONE_TIME_PRODUCT_IDS = [
  'oto1_lifetime',
  'oto3_bundle_all',
  'oto3_bundle_1',
  'oto3_bundle_2',
  'oto3_bundle_3',
  'oto4_pdf',
  'oto5_pdf',
  'oto6_pdf',
  'oto7_pdf',
] as const satisfies readonly ProductId[];

export const CATALOG_CURRENCIES = [
  'eur', 'usd', 'czk', 'huf', 'ron', 'twd', 'ils', 'pln', 'dkk', 'jpy',
] as const satisfies readonly Currency[];
