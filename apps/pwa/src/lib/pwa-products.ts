import { PRICE_BATCH, PRODUCT_CODE_PREFIX, type ProductId } from "@repo/shared/price-map";

/**
 * The single place that says WHICH products the member area is allowed to sell.
 *
 * TODO(new product): edit this file, not the routes. Everything downstream —
 * the purchase opener, the confirm/grant allowlist, the paywall and the
 * one-time purchase sheet — reads these constants, so nothing in the member
 * area hardcodes a slug or an offering code.
 *
 * The allowlist is deliberately fail-closed: a slug that is not listed here can
 * never open an order, and a product code that is not derived from a listed
 * slug can never grant an entitlement.
 */

/**
 * The recurring add-on the member area upsells. Charged immediately (there is
 * no in-app free trial in the boilerplate) and grants for one finite period.
 */
export const PWA_SUBSCRIPTION_PRODUCT = "oto2_addon_weekly" as const satisfies ProductId;

/** Length of one PWA_SUBSCRIPTION_PRODUCT billing period, in milliseconds. */
export const PWA_SUBSCRIPTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * catalog-ids.json key holding the Solidgate product/price ids for the
 * subscription above. Only subscriptions need a provider product id; one-time
 * products are priced inline from PRICE_MAP.
 */
export const PWA_SUBSCRIPTION_CATALOG_KEY = "addon_direct" as const;

/**
 * Every product the member area may open an order for. The subscription plus
 * the one-time digital products the funnel also sells, so a buyer who skipped
 * an OTO can still pick it up from inside the app.
 */
export const PWA_SLUGS: ReadonlySet<ProductId> = new Set<ProductId>([
  PWA_SUBSCRIPTION_PRODUCT,
  "oto3_bundle_all",
  "oto3_bundle_1",
  "oto3_bundle_2",
  "oto3_bundle_3",
  "oto4_pdf",
  "oto5_pdf",
  "oto6_pdf",
  "oto7_pdf",
]);

/** Same set, as an array — the confirm route needs a stable iteration order. */
export const PWA_PRODUCT_IDS = [...PWA_SLUGS] as readonly ProductId[];

/**
 * Shape of a generated offering code, e.g. `BRANDADDON_000000_SUB` and its
 * per-locale variant `LT_BRANDADDON_000000_SUB`. Analytics uses this to tell a
 * technical code apart from a human product label supplied by the provider.
 * Derived from the contract constants so renaming the brand cannot desync it.
 */
export const PRODUCT_CODE_PATTERN = new RegExp(
  `^([A-Z]{2}_)?${PRODUCT_CODE_PREFIX}[A-Z0-9]*_\\d{${PRICE_BATCH.length}}_(?:PDF|SUB)$`,
);
