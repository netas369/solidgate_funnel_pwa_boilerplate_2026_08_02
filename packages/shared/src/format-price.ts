/**
 * Phase 1028  -  Currency-aware price formatter.
 *
 * Takes the project's `Locale` (not raw BCP-47). Consumes Phase 1024's
 * ZERO_DECIMAL_CURRENCIES to avoid divide-by-100 for TWD/JPY/etc.
 * For zero-decimal currencies, amountCents is already whole units
 * (the PSP smallest-unit convention)  -  see price-map.ts.
 */
import type { Currency, Locale } from './price-map';
import { ZERO_DECIMAL_CURRENCIES } from './price-map';

const LOCALE_TO_BCP47: Record<Locale, string> = {
  en: 'en-US',
  lt: 'lt-LT',
  lv: 'lv-LV',
  el: 'el-GR',
  hr: 'hr-HR',
  cs: 'cs-CZ',
  'zh-TW': 'zh-TW',
  ru: 'ru-RU',
  hu: 'hu-HU',
  sk: 'sk-SK',
  ro: 'ro-RO',
  he: 'he-IL',
  pl: 'pl-PL',
  da: 'da-DK',
  ja: 'ja-JP',
};

export function formatPrice(
  amountCents: number,
  currency: Currency,
  locale: Locale,
  options?: { compact?: boolean },
): string {
  const bcp47 = LOCALE_TO_BCP47[locale];
  if (!bcp47) {
    console.warn(
      `[formatPrice] Unknown locale: ${locale}  -  falling back to en/eur`,
    );
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(amountCents / 100);
  }
  const currencyLower = String(currency).toLowerCase();
  const currencyUpper = String(currency).toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(currencyLower);
  const value = isZeroDecimal ? amountCents : amountCents / 100;
  const compact = options?.compact === true;

  // ICU quirk: zh-TW collapses NT$ → $ for TWD (since it's the default currency
  // in Taiwan). The user-facing contract requires the disambiguated NT$ symbol,
  // so we force the en-TW formatter for TWD only. Number grouping is identical
  // between zh-TW and en-TW, so visual layout is unchanged.
  const effectiveBcp47 =
    currencyLower === 'twd' && bcp47 === 'zh-TW' ? 'en-TW' : bcp47;

  return new Intl.NumberFormat(effectiveBcp47, {
    style: 'currency',
    currency: currencyUpper,
    ...(isZeroDecimal || compact
      ? { minimumFractionDigits: 0, maximumFractionDigits: 0 }
      : {}),
  }).format(value);
}
