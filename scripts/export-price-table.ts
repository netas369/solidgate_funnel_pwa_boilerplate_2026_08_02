/**
 * One-shot exporter: reads PRICE_MAP and writes a CSV suitable for importing
 * into Google Sheets — one row per product x locale.
 *
 *   npx tsx scripts/export-price-table.ts
 *
 * Output: scripts/out/prices-export.csv  (gitignored)
 *
 * Product labels are DERIVED from packages/shared/src/solidgate/catalog.ts
 * rather than kept in a table here. The previous version hand-maintained three
 * parallel ProductId maps, which drifted the moment a product was renamed.
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
import {
  ONE_TIME_PRODUCT_IDS,
  PRODUCT_ID_TO_CODE,
  PRODUCT_ID_TO_DISPLAY_NAME,
} from '../packages/shared/src/solidgate/catalog';
import { routing } from '../packages/i18n/src/routing';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(__dirname, 'out/prices-export.csv');

/** Every routing locale, so adding a locale needs no edit here. */
const LOCALES = routing.locales as readonly Locale[];

/** Intl formatting tag per locale. Falls back to the bare locale tag. */
const LOCALE_TO_BCP47: Partial<Record<Locale, string>> = {
  en: 'en-US', lt: 'lt-LT', lv: 'lv-LV', el: 'el-GR', hr: 'hr-HR',
  cs: 'cs-CZ', 'zh-TW': 'zh-TW', ru: 'ru-RU', hu: 'hu-HU', sk: 'sk-SK',
  ro: 'ro-RO', he: 'he-IL', pl: 'pl-PL', da: 'da-DK', ja: 'ja-JP',
};

function formatPrice(amountCents: number, currency: Currency, locale: Locale): string {
  const bcp47 = LOCALE_TO_BCP47[locale] ?? locale;
  const cl = currency.toLowerCase();
  const isZero = ZERO_DECIMAL_CURRENCIES.has(cl);
  const value = isZero ? amountCents : amountCents / 100;
  // zh-TW renders TWD as "NT$" only under an en-* tag; see format-price.ts.
  const effective = cl === 'twd' && bcp47 === 'zh-TW' ? 'en-TW' : bcp47;
  return new Intl.NumberFormat(effective, {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...(isZero ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(value);
}

/** Subscription vs one-time, derived from the catalog. */
function productKind(productId: ProductId): string {
  return (ONE_TIME_PRODUCT_IDS as readonly string[]).includes(productId)
    ? 'One-time'
    : 'Subscription';
}

function csvEscape(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const header = [
  'Product ID',
  'Display Name',
  'Kind',
  'Offering Code',
  'Per-locale Product Code',
  'Locale',
  'Currency',
  'Amount (display)',
  'Compare-at (display)',
  'Amount (smallest unit)',
  'Compare-at (smallest unit)',
];

const rows: string[] = [header.map(csvEscape).join(',')];

for (const [productId, perLocale] of Object.entries(PRICE_MAP) as [
  ProductId,
  Record<Locale, { amountCents: number; productName: string; compareAtCents?: number }>,
][]) {
  for (const locale of LOCALES) {
    const entry = perLocale[locale];
    if (!entry) continue;
    const currency = LOCALE_CURRENCY_MAP[locale];
    rows.push(
      [
        productId,
        PRODUCT_ID_TO_DISPLAY_NAME[productId] ?? productId,
        productKind(productId),
        PRODUCT_ID_TO_CODE[productId] ?? '',
        entry.productName,
        locale,
        currency.toUpperCase(),
        formatPrice(entry.amountCents, currency, locale),
        entry.compareAtCents !== undefined
          ? formatPrice(entry.compareAtCents, currency, locale)
          : '',
        String(entry.amountCents),
        entry.compareAtCents !== undefined ? String(entry.compareAtCents) : '',
      ].map(csvEscape).join(','),
    );
  }
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, rows.join('\n') + '\n', 'utf8');
console.log(`Wrote ${rows.length - 1} rows to ${OUT_FILE}`);
