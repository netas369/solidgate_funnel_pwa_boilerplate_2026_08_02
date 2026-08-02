import catalogIds from '@repo/shared/solidgate/catalog-ids.json';
import { LOCALE_CURRENCY_MAP, type Locale, type ProductId } from '@repo/shared/price-map';

/**
 * `catalog-ids.json` ships with EMPTY strings — a fresh boilerplate has no PSP
 * catalog until you create one.
 *
 * Without a guard, an unseeded checkout POSTs `product_id: ""` to Solidgate and
 * the buyer sees a generic failure while the logs say nothing useful. Fail
 * loudly instead, naming the exact command that fixes it.
 */
export const SOLIDGATE_SEED_COMMAND = 'npx tsx scripts/solidgate-seed-catalog.ts --apply';

type CatalogIds = Record<string, { product_id: string; prices: Record<string, string> }>;

/**
 * Internal product id → catalog-ids.json key.
 *
 * Only products the PSP models as a *catalog product* appear here. The OTO
 * downloads are amount-based one-off charges with no catalog entry, so they
 * are intentionally absent — a missing key means "nothing to check".
 */
const CATALOG_KEY_BY_PRODUCT: Partial<Record<ProductId, string>> = {
  trial1: 'trial1',
  trial2: 'trial2',
  trial3: 'trial3',
  trial4: 'trial4',
  special_1eur: 'special_1eur',
  special_free: 'special_free',
  oto2_addon_weekly: 'addon_trial',
};

/**
 * Returns a developer-facing error string when the PSP catalog has no usable
 * ids for this product/locale, or null when the charge may proceed.
 */
export function solidgateCatalogError(productId: ProductId, locale: Locale): string | null {
  const key = CATALOG_KEY_BY_PRODUCT[productId];
  if (!key) return null;
  const entry = (catalogIds as CatalogIds)[key];
  const currency = LOCALE_CURRENCY_MAP[locale];
  const priceId = entry?.prices?.[currency];
  if (entry?.product_id && priceId) return null;
  return (
    `Solidgate catalog is not seeded for "${productId}" (${currency.toUpperCase()}). ` +
    `Run \`${SOLIDGATE_SEED_COMMAND}\` and commit the regenerated ` +
    'packages/shared/src/solidgate/catalog-ids.json before taking payments.'
  );
}
