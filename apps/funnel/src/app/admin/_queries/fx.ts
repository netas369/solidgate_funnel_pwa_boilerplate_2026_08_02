// D-22: unified-EUR revenue display.
// ADMIN_FX_RATES env format: COMMA-SEPARATED `CODE:RATE` pairs (e.g. 'USD:0.92,GBP:1.17').
// RATE is the multiplier from source currency to EUR.
// Missing currencies fall back to 1.0 with a console.warn (surfaced as a UI warning row in Plan 05).
// Server-only — never imported from 'use client' modules.

function parseRates(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    const code = pair.slice(0, idx).trim().toUpperCase();
    const rate = Number.parseFloat(pair.slice(idx + 1).trim());
    if (!code || !Number.isFinite(rate)) continue;
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
 * EUR rows pass through. Missing rates fall back to 1.0 with a console.warn.
 */
export function convertToEur(amountCents: number, currency: string): number {
  const code = (currency ?? '').toUpperCase();
  if (!code || code === 'EUR') return amountCents;
  const rate = ADMIN_FX_RATES[code];
  if (rate === undefined) {
    console.warn(`[admin/fx] missing FX rate for ${code} — falling back to 1.0`);
    return amountCents;
  }
  const minorUnits = ZERO_DECIMAL_CURRENCIES.has(code)
    ? amountCents * 100
    : amountCents;
  return Math.round(minorUnits * rate);
}
