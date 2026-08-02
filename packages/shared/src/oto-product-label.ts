// ─── Order → friendly product key resolver ──────────────────────────────────
// The `orders.product_slug` column is written by two different conventions
// depending on which charge route created the row:
//   1. The locale-coded company code (e.g. `EN_BRANDPDF7_000000_PDF`) — used by
//      the one-time OTO / download routes (charge-oto, lifetime).
//   2. The internal friendly product id (e.g. `oto2_addon_weekly`, `trial3`,
//      `special_1eur`) — used by the subscription/intro routes.
//
// The OTO-8 summary page needs a single stable key per product *family* so it
// can look up a localized display label. This maps BOTH conventions onto the
// same small set of keys.
//
// NOTE: this union is a CONTRACT with `messages/en/success.json` →
// `products.*` / `orderProducts.*` and with the admin OTO breakdown. Rename
// both sides together or those surfaces render blanks — silently.

export type ProductKey =
  | 'subscription'
  | 'lifetime'
  | 'addon'
  | 'bundleAll'
  | 'bundle1'
  | 'bundle2'
  | 'bundle3'
  | 'pdf4'
  | 'pdf5'
  | 'pdf6'
  | 'pdf7'
  | 'unknown';

// Internal friendly product ids (matches PRICE_MAP keys in price-map.ts).
const INTERNAL_ID_TO_KEY: Record<string, ProductKey> = {
  trial1: 'subscription',
  trial2: 'subscription',
  trial3: 'subscription',
  trial4: 'subscription',
  trial_monthly: 'subscription',
  special_1eur: 'subscription',
  special_free: 'subscription',
  oto1_lifetime: 'lifetime',
  oto2_addon_weekly: 'addon',
  oto3_bundle_all: 'bundleAll',
  oto3_bundle_1: 'bundle1',
  oto3_bundle_2: 'bundle2',
  oto3_bundle_3: 'bundle3',
  oto4_pdf: 'pdf4',
  oto5_pdf: 'pdf5',
  oto6_pdf: 'pdf6',
  oto7_pdf: 'pdf7',
};

// Company-code product token (the segment after the country prefix) → key.
// e.g. `EN_BRANDPDF7_000000_PDF` → token `BRANDPDF7`.
const CODE_TOKEN_TO_KEY: Record<string, ProductKey> = {
  BRAND: 'subscription',
  BRANDLIFETIME: 'lifetime',
  BRANDADDON: 'addon',
  BRANDBUNDLE: 'bundleAll',
  BRANDBUNDLE1: 'bundle1',
  BRANDBUNDLE2: 'bundle2',
  BRANDBUNDLE3: 'bundle3',
  BRANDPDF4: 'pdf4',
  BRANDPDF5: 'pdf5',
  BRANDPDF6: 'pdf6',
  BRANDPDF7: 'pdf7',
};

/**
 * Resolve a stable product key from an `orders.product_slug` value, accepting
 * either the internal friendly id or the locale-coded company code.
 * Returns `'unknown'` for anything unrecognised so callers can still render a
 * generic line rather than crashing.
 */
export function productKeyFromSlug(slug: string | null | undefined): ProductKey {
  if (!slug) return 'unknown';

  const direct = INTERNAL_ID_TO_KEY[slug];
  if (direct) return direct;

  // Two code shapes must resolve, forever:
  //   locale-prefixed  `{COUNTRY}_{TOKEN}_{BATCH}_{KIND}`  → token is parts[1]
  //   locale-agnostic  `{TOKEN}_{BATCH}_{KIND}`            → token is parts[0]
  // History keeps the locale-prefixed codes; PSP-issued orders have none.
  // Reading only parts[1] resolved every locale-agnostic purchase to 'unknown',
  // so the OTO-8 summary and the admin OTO breakdown showed nothing.
  const parts = slug.split('_');
  for (const candidate of [parts[0], parts[1]]) {
    if (!candidate) continue;
    const byToken = CODE_TOKEN_TO_KEY[candidate];
    if (byToken) return byToken;
  }

  return 'unknown';
}
