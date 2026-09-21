// D-22: unified-EUR revenue display.
// ADMIN_FX_RATES env format: COMMA-SEPARATED `CODE:RATE` pairs (e.g. 'USD:0.92,GBP:1.17').
// RATE is the multiplier from source currency to EUR.
// Missing rates return null. A different currency is never silently treated as EUR.
// Server-only — never imported from 'use client' modules.

function parseRates(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const code = pair.slice(0, idx).trim().toUpperCase();
    const rate = Number(pair.slice(idx + 1).trim());
    if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0) continue;
    out[code] = rate;
  }
  return out;
}

export const ADMIN_FX_RATES: Readonly<Record<string, number>> = Object.freeze(
  parseRates(process.env.ADMIN_FX_RATES),
);

// Currencies with no minor unit: rows store MAJOR units (¥926 is stored as
// 926, on both PSPs), so they must be scaled to cent-space before the per-unit
// rate applies — otherwise a naturally-quoted rate (JPY:0.0054) undercounts
// Japanese revenue 100×.
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

/**
 * Convert a per-row order/invoice amount (in source-currency cents) to EUR cents.
 * Display estimate at configured rates, not a settlement FX record.
 * Native-currency amounts remain exact when conversion is unavailable.
 */
export function convertToEur(amountCents: number, currency: string): number | null {
  if (!Number.isSafeInteger(amountCents)) throw new Error('Invalid monetary amount');
  const code = (currency ?? '').toUpperCase();
  if (code === 'EUR' || amountCents === 0) return amountCents;
  const rate = ADMIN_FX_RATES[code];
  if (rate === undefined) {
    return null;
  }
  const minorUnits = ZERO_DECIMAL_CURRENCIES.has(code)
    ? amountCents * 100
    : amountCents;
  const converted = Math.round(minorUnits * rate);
  if (!Number.isSafeInteger(converted)) throw new Error('Converted amount exceeds safe precision');
  return converted;
}
