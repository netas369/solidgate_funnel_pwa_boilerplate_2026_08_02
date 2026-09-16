// PostgreSQL aggregates financial movements, avoiding Data API row limits and
// mutable order/access status filters. All amounts are native minor units.
import { z } from 'zod';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { convertToEur } from './fx';
import type { DateRange } from './_shared';

const Money = z.number().int().safe();
const ReportSchema = z.object({
  rows: z.array(z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    billing_type: z.enum(['initial', 'renewal']),
    product_slug: z.string().nullable(),
    captured_cents: Money,
    refunded_cents: Money,
    chargeback_cents: Money,
    net_cents: Money,
    payments: z.number().int().nonnegative(),
  })),
  legacy_movements: z.number().int().nonnegative(),
  estimated_timing_movements: z.number().int().nonnegative().default(0),
});
export type FinancialReport = z.infer<typeof ReportSchema>;
export type FinancialRow = FinancialReport['rows'][number];
export type RevenueSummary = {
  oneTimeEur: number | null;
  renewalEur: number | null;
  totalEur: number | null;
  grossEur: number | null;
  refundsEur: number | null;
  chargebacksEur: number | null;
  byCurrency: Record<string, number>;
  currencyTotals: Array<{ currency: string; captured: number; refunded: number; chargeback: number; net: number }>;
  timeSeries: Array<{ date: string; value: number }>;
  missingFxCurrencies: string[];
  legacyMovements: number;
  estimatedTimingMovements: number;
};

export async function financialReport({ from, to }: DateRange): Promise<FinancialReport> {
  const { data, error } = await getSupabaseAdminClient().rpc('get_solidgate_revenue_report', {
    p_environment: 'production', p_from: from, p_to: to,
  });
  if (error) throw new Error(`Revenue report unavailable: ${error.message}`);
  return ReportSchema.parse(data);
}

function addExact(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new Error('Monetary total exceeds safe precision');
  return value;
}

export function sumInEur(rows: FinancialRow[], field: 'captured_cents' | 'refunded_cents' | 'chargeback_cents' | 'net_cents' = 'net_cents'): number | null {
  const grouped = new Map<string, number>();
  for (const row of rows) {
    const code = row.currency.toUpperCase();
    grouped.set(code, addExact(grouped.get(code) ?? 0, row[field]));
  }
  let total = 0;
  for (const [currency, amount] of grouped) {
    const value = convertToEur(amount, currency);
    if (value === null) return null;
    total = addExact(total, value);
  }
  return total;
}

export function summarizeFinancialReport(report: FinancialReport): RevenueSummary {
  const totals = new Map<string, { currency: string; captured: number; refunded: number; chargeback: number; net: number }>();
  const days = new Map<string, FinancialRow[]>();
  const missingFx = new Set<string>();
  for (const row of report.rows) {
    const code = row.currency.toUpperCase();
    const total = totals.get(code) ?? { currency: code, captured: 0, refunded: 0, chargeback: 0, net: 0 };
    total.captured = addExact(total.captured, row.captured_cents);
    total.refunded = addExact(total.refunded, row.refunded_cents);
    total.chargeback = addExact(total.chargeback, row.chargeback_cents);
    total.net = addExact(total.net, row.net_cents);
    totals.set(code, total);
    const dayRows = days.get(row.day) ?? [];
    dayRows.push(row);
    days.set(row.day, dayRows);
    if ([row.captured_cents, row.refunded_cents, row.chargeback_cents, row.net_cents].some(amount => convertToEur(amount, code) === null)) missingFx.add(code);
  }
  const currencyTotals = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    oneTimeEur: sumInEur(report.rows.filter(row => row.billing_type === 'initial')),
    renewalEur: sumInEur(report.rows.filter(row => row.billing_type === 'renewal')),
    totalEur: sumInEur(report.rows),
    grossEur: sumInEur(report.rows, 'captured_cents'),
    refundsEur: sumInEur(report.rows, 'refunded_cents'),
    chargebacksEur: sumInEur(report.rows, 'chargeback_cents'),
    byCurrency: Object.fromEntries(currencyTotals.map(row => [row.currency, row.net])),
    currencyTotals,
    // Never show a partial EUR chart as though it covered all currencies.
    timeSeries: missingFx.size ? [] : [...days.entries()].map(([date, rows]) => ({ date, value: sumInEur(rows)! })).sort((a, b) => a.date.localeCompare(b.date)),
    missingFxCurrencies: [...missingFx].sort(),
    legacyMovements: report.legacy_movements,
    estimatedTimingMovements: report.estimated_timing_movements,
  };
}

export async function revenueSummaryInRange(range: DateRange): Promise<RevenueSummary> {
  return summarizeFinancialReport(await financialReport(range));
}

/** Captured gross includes both initial payments and renewals. */
export async function grossRevenueInEurInRange(range: DateRange): Promise<number | null> {
  return sumInEur((await financialReport(range)).rows, 'captured_cents');
}
export async function netRevenueInEurInRange(range: DateRange): Promise<number | null> {
  return sumInEur((await financialReport(range)).rows);
}
export async function revenueByCurrencyInRange(range: DateRange): Promise<Record<string, number>> {
  return (await revenueSummaryInRange(range)).byCurrency;
}
export async function renewalRevenueInEur(range: DateRange): Promise<number | null> {
  return sumInEur((await financialReport(range)).rows.filter(row => row.billing_type === 'renewal'));
}
export async function revenueTimeSeriesInEur(range: DateRange): Promise<Array<{ date: string; value: number }>> {
  return (await revenueSummaryInRange(range)).timeSeries;
}
