// Locale → market prefix: the naming grammar every per-buyer artifact is built
// on (price-map company codes, CRM list/tag names, Solidgate order
// descriptions).
//
// The CATALOG stays locale-agnostic (one product per offering, priced in every
// currency); the prefix belongs on per-buyer artifacts only: an order has
// exactly one locale, a product has all of them.

export type LocalePrefix =
  | 'EN' | 'CZ' | 'HU' | 'SK' | 'RO' | 'LT' | 'RU' | 'LV'
  | 'TW' | 'GR' | 'PL' | 'IL' | 'HR' | 'DK' | 'JP';

export const LOCALE_COMPANY_PREFIXES: Record<string, LocalePrefix> = {
  en: 'EN',
  cs: 'CZ',
  hu: 'HU',
  sk: 'SK',
  ro: 'RO',
  lt: 'LT',
  ru: 'RU',
  lv: 'LV',
  'zh-TW': 'TW',
  el: 'GR',
  pl: 'PL',
  he: 'IL',
  hr: 'HR',
  da: 'DK',
  ja: 'JP',
};

/**
 * A per-buyer order description carrying the locale prefix and an optional
 * `o:` origin offer:
 *
 *   main checkout:  EN_BRAND_000000_SUB
 *   OTO / upsell:   EN_BRANDLIFETIME_000000_SUB o:EN_BRAND_000000_SUB
 *
 * `o:` names the originating offer the buyer came from. The locale in the
 * description is redundant with order_metadata.locale — it is there so the
 * description alone is enough to attribute an order in a spreadsheet export.
 */
export function solidgateOrderDescription(
  locale: string,
  productCode: string,
  originCode?: string,
): string {
  const prefix = LOCALE_COMPANY_PREFIXES[locale];
  const coded = prefix ? `${prefix}_${productCode}` : productCode;
  if (!originCode) return coded;
  return `${coded} o:${prefix ? `${prefix}_${originCode}` : originCode}`;
}
