import type { ProductId } from '@repo/shared/price-map';

/**
 * The products the MAIN checkout can sell. Narrower than `ProductId` on
 * purpose: `computeTierPrices` needs a per-plan day/month divisor for each one,
 * so adding a tier here forces you to add its cadence too.
 */
export type MainProductId =
  | 'trial1'
  | 'trial2'
  | 'trial3'
  | 'trial4'
  | 'trial_monthly'
  | 'special_1eur'
  | 'special_free';

/**
 * The offer's pricing tiers.
 *
 * Every string field is an i18n KEY resolved with `useTranslations('offer')`,
 * never literal copy. Displayed amounts always come from
 * `resolveProductPrice(productId, locale)` — the strings never carry a price,
 * so a currency or price change is a one-line edit in PRICE_MAP.
 *
 * TODO(new product): replace the copy keys and the tier line-up. Keep the
 * `productId` values: they are PRICE_MAP keys and are load-bearing across the
 * checkout, the ?sg_order / ?sg_main recovery validators and the price picker.
 */
export interface OfferPricingTier {
  id: string;
  /** Authoritative PRICE_MAP key — the charged amount lives there, not here. */
  productId: MainProductId;
  name: string;
  duration: string;
  monthlyPrice: string;
  totalNote: string;
  originalTotal: string;
  discountedTotal: string;
  discountPct: number;
  billingCadence: string;
  badge?: string;
  highlighted?: boolean;
  ctaText: string;
}

const DEFAULT_TIER_COPY = {
  name: 'pricing.tiers.default.name',
  duration: 'pricing.tiers.default.duration',
  monthlyPrice: 'pricing.tiers.default.monthlyPrice',
  totalNote: 'pricing.tiers.default.totalNote',
  originalTotal: 'pricing.tiers.default.originalTotal',
  discountedTotal: 'pricing.tiers.default.discountedTotal',
  billingCadence: 'pricing.tiers.default.billingCadence',
  ctaText: 'pricing.tiers.default.ctaText',
  discountPct: 0,
} as const;

/**
 * Four intro tiers plus the two special-offer entry points.
 *
 * `tier1..tier4` are what the /offer price picker maps onto (picker id
 * `trialN` → `tierN`); `tier_special_1eur` / `tier_special_free` back the
 * /special-offer and /special-offer-free landing pages.
 */
export const OFFER_PRICING_TIERS: readonly OfferPricingTier[] = [
  { id: 'tier1', productId: 'trial1', ...DEFAULT_TIER_COPY },
  { id: 'tier2', productId: 'trial2', ...DEFAULT_TIER_COPY },
  { id: 'tier3', productId: 'trial3', ...DEFAULT_TIER_COPY },
  { id: 'tier4', productId: 'trial4', ...DEFAULT_TIER_COPY },
  { id: 'tier_special_1eur', productId: 'special_1eur', ...DEFAULT_TIER_COPY },
  { id: 'tier_special_free', productId: 'special_free', ...DEFAULT_TIER_COPY },
];

/**
 * Every product id the MAIN checkout can sell. Consumed by
 * `features/oto/lib/main-payment-recovery.ts` to validate a returning 3DS
 * order — a tier missing from this list has its recovery silently refused.
 */
export const MAIN_PRODUCT_IDS: readonly ProductId[] = OFFER_PRICING_TIERS.map(
  (tier) => tier.productId,
);

/** The four picker options on /offer, in display order. */
export const OFFER_PICKER_PRODUCT_IDS = ['trial1', 'trial2', 'trial3', 'trial4'] as const;
export type OfferPickerId = (typeof OFFER_PICKER_PRODUCT_IDS)[number];
