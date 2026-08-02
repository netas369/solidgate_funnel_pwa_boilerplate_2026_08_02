import {
  LOCALE_CURRENCY_MAP,
  PRODUCT_CODE_PREFIX,
  resolveProductPrice,
  type Locale,
  type ProductId,
} from '@repo/shared/price-map';
import {
  PRODUCT_ID_TO_CODE,
  PRODUCT_ID_TO_DISPLAY_NAME,
  SOLIDGATE_PRODUCTS,
} from '@repo/shared/solidgate/catalog';
import catalogIds from '@repo/shared/solidgate/catalog-ids.json';

/**
 * The single source of truth for the funnel identifier stamped into Solidgate
 * `tracking_metadata`. THREE independent verifiers re-assert it as a hard gate:
 * proxy.ts (OTO page admission), lib/payment/solidgate-access.ts (saved-card
 * reuse) and api/solidgate/grant (entitlement grant). Change it in one place
 * only — a mismatch fails CLOSED and silently, as a redirect to /offer or a
 * 403, never as an error you can see in a log.
 *
 * Tied to the product-code grammar so there is one brand token in the repo.
 */
export const FUNNEL_CODE = PRODUCT_CODE_PREFIX;

/**
 * Upsell slots that START A SUBSCRIPTION on the vaulted card instead of
 * charging it once. The value is the catalog-ids.json key holding that
 * subscription's PSP product id + per-currency price ids.
 *
 * A one-time OTO carries NO PSP product (it is an amount-based POST
 * /recurring), so this map is what forks the charge route, the order-binding
 * verifier and the capture-state check.
 *
 * TODO(new product): add or remove entries as your OTO chain changes.
 */
export const SUBSCRIPTION_OTO_CATALOG_KEYS: Partial<Record<ProductId, string>> = {
  oto2_addon_weekly: 'addon_trial',
};

/** catalog-ids.json key for a subscription OTO, or null for a one-time OTO. */
export function subscriptionOtoCatalogKey(productId: ProductId): string | null {
  return SUBSCRIPTION_OTO_CATALOG_KEYS[productId] ?? null;
}

/** True when this upsell slot starts a subscription rather than charging once. */
export function isSubscriptionOto(productId: ProductId): boolean {
  return subscriptionOtoCatalogKey(productId) !== null;
}

type CatalogIds = Record<string, { product_id: string; prices: Record<string, string> }>;

export interface PaymentProductContext {
  payment_provider: 'solidgate';
  billing_type: 'subscription_initial' | 'one_time';
  surface: 'funnel';
  funnel_code: typeof FUNNEL_CODE;
  funnel_variant: string;
  product: ProductId;
  /** Stable data-team offering code (not the PSP's UUID). */
  product_id: string;
  product_code: string;
  product_name: string;
  product_slug: ProductId;
  /** PSP price UUID when a catalog price exists; null for amount-based OTOs. */
  price_id: string | null;
  solidgate_product_id: string | null;
  solidgate_price_id: string | null;
  amount_cents: number;
  recurring_amount_cents?: number;
  currency: string;
}

export interface CheckoutProductContext extends PaymentProductContext {
  billing_type: 'subscription_initial';
  funnel_variant: 'main' | 'special_1eur' | 'special_free';
  price_id: string;
  solidgate_product_id: string;
  solidgate_price_id: string;
}

export function checkoutFunnelVariant(
  productId: ProductId,
): CheckoutProductContext['funnel_variant'] {
  if (productId === 'special_1eur') return 'special_1eur';
  if (productId === 'special_free') return 'special_free';
  return 'main';
}

/** Stable product vocabulary shared by PSP metadata and analytics events. */
export function checkoutProductContext(
  productId: ProductId,
  locale: Locale,
): CheckoutProductContext | null {
  const currency = LOCALE_CURRENCY_MAP[locale];
  const entry = (catalogIds as CatalogIds)[productId];
  const priceId = entry?.prices?.[currency];
  const definition = SOLIDGATE_PRODUCTS.find((product) => product.key === productId);
  if (!entry?.product_id || !priceId || !definition) return null;
  const price = resolveProductPrice(productId, locale);
  return {
    payment_provider: 'solidgate',
    billing_type: 'subscription_initial',
    surface: 'funnel',
    funnel_code: FUNNEL_CODE,
    funnel_variant: checkoutFunnelVariant(productId),
    product: productId,
    product_id: PRODUCT_ID_TO_CODE[productId],
    product_code: PRODUCT_ID_TO_CODE[productId],
    product_name: definition.displayName,
    product_slug: productId,
    price_id: priceId,
    solidgate_product_id: entry.product_id,
    solidgate_price_id: priceId,
    amount_cents: price.amountCents,
    currency: currency.toUpperCase(),
  };
}

export function otoFunnelVariant(productId: ProductId): string {
  const match = /^oto(\d+)_/.exec(productId);
  return match ? `oto${match[1]}` : 'oto';
}

/** Canonical OTO product schema. Amount-based OTOs truthfully have no PSP price UUID. */
export function otoProductContext(
  productId: ProductId,
  locale: Locale,
  actual?: { amountCents?: number; currency?: string },
): PaymentProductContext | null {
  const productName = PRODUCT_ID_TO_DISPLAY_NAME[productId];
  if (!productName) return null;
  const productCode = PRODUCT_ID_TO_CODE[productId];
  const currency = LOCALE_CURRENCY_MAP[locale];
  const price = resolveProductPrice(productId, locale);
  const catalogKey = subscriptionOtoCatalogKey(productId);
  const isSubscription = catalogKey !== null;
  const catalogEntry = catalogKey
    ? (catalogIds as CatalogIds)[catalogKey]
    : undefined;
  const solidgatePriceId = catalogEntry?.prices?.[currency] ?? null;
  return {
    payment_provider: 'solidgate',
    billing_type: isSubscription ? 'subscription_initial' : 'one_time',
    surface: 'funnel',
    funnel_code: FUNNEL_CODE,
    funnel_variant: otoFunnelVariant(productId),
    product: productId,
    product_id: productCode,
    product_code: productCode,
    product_name: productName,
    product_slug: productId,
    price_id: solidgatePriceId,
    solidgate_product_id: catalogEntry?.product_id ?? null,
    solidgate_price_id: solidgatePriceId,
    // A subscription OTO's own order is the (possibly €0) intro; PRICE_MAP
    // holds the RECURRING amount, which rides along separately.
    amount_cents: actual?.amountCents ?? (isSubscription ? 0 : price.amountCents),
    ...(isSubscription ? { recurring_amount_cents: price.amountCents } : {}),
    currency: (actual?.currency ?? currency).toUpperCase(),
  };
}

/** One purchase/order produces one ID across PostHog, GTM, Pixel and CAPI. */
export function purchaseEventId(orderId: string): string {
  return `purchase:${orderId}`;
}

/** Secondary lifecycle events must not reuse Purchase's PostHog insert ID. */
export function lifecycleEventId(eventName: string, orderId: string): string {
  return `${eventName}:${orderId}`;
}
