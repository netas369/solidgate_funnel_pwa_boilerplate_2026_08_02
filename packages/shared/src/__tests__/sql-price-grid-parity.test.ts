// ─── SQL <-> TypeScript price-grid parity ────────────────────────────────────
// The database is the authority the browser's amount is checked against:
// guard_solidgate_main_payable_order() compares the inserted amount_cents
// against solidgate_main_checkout_amount() and rejects a mismatch. That SQL
// grid therefore has to equal PRICE_MAP exactly.
//
// Nothing in the type system connects the two — they are different languages in
// different files — so this test parses the baseline migration and diffs it.
// It exists because the two grids DID drift once (DKK and JPY), which would
// have failed every non-EUR checkout with SQLSTATE 23514 at runtime while every
// other test stayed green.
//
// If you change prices: edit PRICE_MAP, then update section 2 of
// supabase/migrations/00001_baseline.sql to match, then run this test.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCALE_CURRENCY_MAP, PRICE_MAP, type Currency, type Locale } from '../price-map';

const BASELINE = path.resolve(__dirname, '../../../../supabase/migrations/00001_baseline.sql');

/** Intro tiers the SQL function prices. Must match its CASE arms. */
const SQL_PRICED_TIERS = [
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
  'special_free',
] as const;

const CURRENCIES: readonly Currency[] = [
  'eur', 'usd', 'czk', 'huf', 'ron', 'twd', 'ils', 'pln', 'dkk', 'jpy',
];

/**
 * Pull `solidgate_main_checkout_amount`'s body out of the baseline and parse it
 * into { tier: { currency: amount } }.
 */
function parseSqlGrid(sql: string): Record<string, Record<string, number>> {
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.solidgate_main_checkout_amount');
  expect(fnStart, 'solidgate_main_checkout_amount not found in the baseline').toBeGreaterThan(-1);

  const bodyStart = sql.indexOf('AS $$', fnStart);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  const body = sql.slice(bodyStart, bodyEnd);

  const grid: Record<string, Record<string, number>> = {};

  // Each tier arm looks like:  WHEN 'trial1' THEN CASE LOWER(p_currency) ... END
  const armRe = /WHEN\s+'([a-z0-9_]+)'\s+THEN\s+CASE\s+LOWER\(p_currency\)([\s\S]*?)\bEND\b/g;
  for (const arm of body.matchAll(armRe)) {
    const tier = arm[1];
    const inner = arm[2];
    const amounts: Record<string, number> = {};
    for (const m of inner.matchAll(/WHEN\s+'([a-z]{3})'\s+THEN\s+(\d+)/g)) {
      amounts[m[1]] = Number(m[2]);
    }
    grid[tier] = amounts;
  }
  return grid;
}

/**
 * The amount PRICE_MAP charges for a product in a currency. Every locale that
 * resolves to a given currency must agree, or the SQL — which is keyed by
 * currency, not locale — cannot represent it.
 */
function priceMapAmount(tier: string, currency: Currency): number {
  const locales = (Object.keys(LOCALE_CURRENCY_MAP) as Locale[]).filter(
    (l) => LOCALE_CURRENCY_MAP[l] === currency,
  );
  expect(locales.length, `no locale maps to ${currency}`).toBeGreaterThan(0);

  const amounts = new Set(
    locales.map((l) => (PRICE_MAP as Record<string, Record<Locale, { amountCents: number }>>)[tier][l].amountCents),
  );
  expect(
    amounts.size,
    `${tier}/${currency}: locales sharing a currency disagree on amount (${[...amounts].join(', ')}). ` +
      `The SQL grid is keyed by currency and cannot express a per-locale split.`,
  ).toBe(1);

  return [...amounts][0];
}

describe('solidgate_main_checkout_amount() matches PRICE_MAP', () => {
  const sql = readFileSync(BASELINE, 'utf8');
  const grid = parseSqlGrid(sql);

  it('prices exactly the intro tiers the funnel can open a checkout for', () => {
    expect(Object.keys(grid).sort()).toEqual([...SQL_PRICED_TIERS].sort());
  });

  it.each(SQL_PRICED_TIERS)('%s covers all 10 catalog currencies', (tier) => {
    expect(Object.keys(grid[tier]).sort()).toEqual([...CURRENCIES].sort());
  });

  it.each(SQL_PRICED_TIERS)('%s amounts equal PRICE_MAP in every currency', (tier) => {
    for (const currency of CURRENCIES) {
      expect(
        grid[tier][currency],
        `${tier}/${currency}: baseline SQL says ${grid[tier][currency]}, ` +
          `price-map.ts says ${priceMapAmount(tier, currency)}. ` +
          `A mismatch fails that currency's checkout with SQLSTATE 23514.`,
      ).toBe(priceMapAmount(tier, currency));
    }
  });

  it('keeps special_free at zero in every currency (it is the zero-auth tier)', () => {
    for (const currency of CURRENCIES) {
      expect(grid.special_free[currency]).toBe(0);
    }
  });
});
