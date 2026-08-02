// THE PRODUCT CATALOG for the Solidgate webhook (Deno + vitest).
//
// ◀── EDIT THIS FILE PER PRODUCT. It is the only place in the edge function
// that knows what you sell. It must stay identical to:
//   packages/shared/src/price-map.ts          (product ids + offering codes)
//   packages/shared/src/oto-product-label.ts  (ProductKey union)
//   supabase/migrations/00001_baseline.sql    (section 2, PRODUCT CATALOG)
//
// The brand guard: a Solidgate merchant account can be shared across brands,
// and an event for someone else's product must be acknowledged (200) and
// ignored, never acted on. Everything we sell carries a code whose token is a
// key of CODE_TO_SLUG below — that membership test *is* the guard.
//
// Two code shapes must resolve, forever:
//   locale-prefixed  `{COUNTRY}_{TOKEN}_{BATCH}_{KIND}`  e.g. LT_BRANDPDF5_000000_PDF
//   bare             `{TOKEN}_{BATCH}_{KIND}`            e.g. BRANDPDF5_000000_PDF
// Historic orders keep the locale-prefixed codes; new orders have none.

/** Offering code token → internal slug (the id used in PRICE_MAP and analytics). */
export const CODE_TO_SLUG: Record<string, string> = {
  BRAND: 'trial_monthly',
  BRANDADDON: 'oto2_addon_weekly',
  BRANDLIFETIME: 'oto1_lifetime',
  BRANDBUNDLE: 'oto3_bundle_all',
  BRANDBUNDLE1: 'oto3_bundle_1',
  BRANDBUNDLE2: 'oto3_bundle_2',
  BRANDBUNDLE3: 'oto3_bundle_3',
  BRANDPDF4: 'oto4_pdf',
  BRANDPDF5: 'oto5_pdf',
  BRANDPDF6: 'oto6_pdf',
  BRANDPDF7: 'oto7_pdf',
};

/**
 * Buyer-facing labels. These end up in receipts and analytics, so they are
 * deliberately ours rather than whatever the PSP happens to echo back.
 */
const PRODUCT_DISPLAY_NAMES: Record<string, string> = {
  trial1: 'Main Subscription',
  trial2: 'Main Subscription',
  trial3: 'Main Subscription',
  trial4: 'Main Subscription',
  trial_monthly: 'Main Subscription',
  special_1eur: 'Main Subscription',
  special_free: 'Main Subscription',
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

/** The token inside a product code, whichever shape it is written in. */
export function productToken(code: string | null | undefined): string | null {
  if (!code) return null;
  const parts = code.split('_');
  for (const candidate of [parts[0], parts[1]]) {
    if (candidate && candidate in CODE_TO_SLUG) return candidate;
  }
  return null;
}

/** Brand guard: is this one of ours? */
export function isOurProduct(code: string | null | undefined): boolean {
  return productToken(code) !== null;
}

export function slugFromCode(code: string | null | undefined): string | null {
  const token = productToken(code);
  return token ? CODE_TO_SLUG[token] : null;
}

/** Prefer our canonical label; use the PSP label only for an unmapped product. */
export function canonicalProductName(
  slugOrCode: string | null | undefined,
  candidate?: string | null,
): string {
  const slug = slugFromCode(slugOrCode) ?? slugOrCode ?? '';
  const canonical = PRODUCT_DISPLAY_NAMES[slug];
  if (canonical) return canonical;
  const cleanCandidate = candidate?.trim() || null;
  const candidateIsTechnical = cleanCandidate === slugOrCode ||
    cleanCandidate === slug ||
    isOurProduct(cleanCandidate);
  if (cleanCandidate && !candidateIsTechnical) return cleanCandidate;
  return cleanCandidate ?? slug;
}

/** Internal checkout slug → offering token, including main-funnel variants. */
export function productTokenFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (/^trial[1-4]$/.test(slug) || slug === 'trial_monthly' || slug.startsWith('special_')) {
    return 'BRAND';
  }
  return Object.entries(CODE_TO_SLUG).find(([, internalSlug]) => internalSlug === slug)?.[0] ?? null;
}

/** The main subscription — the only offering that drives the buyer lifecycle. */
export function isMainSubscription(code: string | null | undefined): boolean {
  return productToken(code) === 'BRAND';
}

/**
 * The recurring upsell: an OTO that creates a SECOND subscription alongside the
 * main one. It bills on its own (shorter) cadence, so the renewal grace windows
 * and the subscription-vs-one-off branches key off this rather than off the
 * generic "is an OTO" test. If your funnel has no recurring upsell, this can
 * return false unconditionally.
 */
export function isRecurringAddon(code: string | null | undefined): boolean {
  return productToken(code) === 'BRANDADDON';
}

/**
 * The lifetime OTO. Buying it cancels the main subscription — that is an offer
 * design decision, not a platform rule; delete the predicate together with the
 * 'cancel_main_subscription' fulfillment effect if your funnel does not do it.
 */
export function isLifetime(code: string | null | undefined): boolean {
  return productToken(code) === 'BRANDLIFETIME';
}
