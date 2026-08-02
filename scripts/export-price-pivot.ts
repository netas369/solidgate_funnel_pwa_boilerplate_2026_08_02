/**
 * Wide pivot: one row per product, one column per locale.
 * Writes a CSV + a markdown table to scripts/out/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRICE_MAP,
  LOCALE_CURRENCY_MAP,
  ZERO_DECIMAL_CURRENCIES,
  type Locale,
  type Currency,
  type ProductId,
} from '../packages/shared/src/price-map';
import { PRODUCT_ID_TO_DISPLAY_NAME } from '../packages/shared/src/solidgate/catalog';
import { routing } from '../packages/i18n/src/routing';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'out');

/** Every routing locale, so adding a locale needs no edit here. */
const LOCALES = routing.locales as readonly Locale[];

const LOCALE_TO_BCP47: Partial<Record<Locale, string>> = {
  en: 'en-US', lt: 'lt-LT', lv: 'lv-LV', el: 'el-GR', hr: 'hr-HR',
  cs: 'cs-CZ', 'zh-TW': 'zh-TW', ru: 'ru-RU', hu: 'hu-HU', sk: 'sk-SK',
  ro: 'ro-RO', he: 'he-IL', pl: 'pl-PL', da: 'da-DK', ja: 'ja-JP',
};

function fmt(amountCents: number, currency: Currency, locale: Locale): string {
  const bcp47 = LOCALE_TO_BCP47[locale] ?? locale;
  const cl = currency.toLowerCase();
  const isZero = ZERO_DECIMAL_CURRENCIES.has(cl);
  const value = isZero ? amountCents : amountCents / 100;
  const effective = cl === 'twd' && bcp47 === 'zh-TW' ? 'en-TW' : bcp47;
  return new Intl.NumberFormat(effective, {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...(isZero ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(value);
}

/** "EN (USD)" — derived, so a new locale needs no edit. */
function localeHeader(locale: Locale): string {
  return `${locale.toUpperCase()} (${LOCALE_CURRENCY_MAP[locale].toUpperCase()})`;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ─── Build wide table (price only) ────────────────────────────────────────────
const productIds = Object.keys(PRICE_MAP);

const csvLines: string[] = [];
csvLines.push(
  ['Product', 'Product ID', ...LOCALES.map(localeHeader)]
    .map(csvEscape)
    .join(','),
);

const mdLines: string[] = [];
mdLines.push(
  '| Product | ' + LOCALES.map(localeHeader).join(' | ') + ' |',
);
mdLines.push(
  '|---|' + LOCALES.map(() => '---:').join('|') + '|',
);

for (const pid of productIds) {
  const perLocale = PRICE_MAP[pid as keyof typeof PRICE_MAP];
  const csvRow = [PRODUCT_ID_TO_DISPLAY_NAME[pid as ProductId] ?? pid, pid];
  const mdRow = [PRODUCT_ID_TO_DISPLAY_NAME[pid as ProductId] ?? pid];
  for (const locale of LOCALES) {
    const entry = perLocale[locale];
    const cur = LOCALE_CURRENCY_MAP[locale];
    const price = entry ? fmt(entry.amountCents, cur, locale) : '';
    const compare = entry?.compareAtCents !== undefined
      ? fmt(entry.compareAtCents, cur, locale)
      : '';
    const cell = compare ? `${price} (was ${compare})` : price;
    csvRow.push(cell);
    mdRow.push(cell);
  }
  csvLines.push(csvRow.map(csvEscape).join(','));
  mdLines.push('| ' + mdRow.join(' | ') + ' |');
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, 'prices-pivot.csv'), csvLines.join('\n') + '\n', 'utf8');
writeFileSync(resolve(OUT_DIR, 'prices-pivot.md'), mdLines.join('\n') + '\n', 'utf8');

console.log(`Wrote pivot:`);
console.log(`  ${resolve(OUT_DIR, 'prices-pivot.csv')}`);
console.log(`  ${resolve(OUT_DIR, 'prices-pivot.md')}`);
