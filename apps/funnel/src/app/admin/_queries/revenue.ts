// Revenue aggregations in EUR.
// - One-time / OTO orders summed via convertToEur (EUR-unified totals).
// - Renewal events (renewal_events table) summed separately.
// - Collected money is independent of the order's CURRENT lifecycle state: a
//   paid trial settles its intro fee at signup (Solidgate auth_settle), so a
//   'trialing' row with amount > 0 is real revenue, and a sub that later went
//   past_due/canceled keeps the money it already took. The amount_cents > 0
//   predicate excludes zero-auth rows (a free intro tier authorizes €0 and
//   collects nothing); pending/failed never charged, and refunded gave the
//   money back.
// Server-only; never import from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { convertToEur, MissingAdminFxRateError } from './fx';
import type { DateRange } from './_shared';
import { adminConfig } from '@/admin.config';

type OrderRow = { amount_cents: number; currency: string };
type RenewalRow = { amount_cents: number; currency: string; created_at: string };
type OrderTimeRow = OrderRow & { created_at: string };

export interface AverageCustomerLtvMetric {
  averageNetLtvEurCents: number;
  customerCount: number;
  totalNetRevenueEurCents: number;
  warning: string | null;
}

async function fetchOneTimeOrders({ from, to }: DateRange): Promise<OrderTimeRow[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('orders')
    .select('amount_cents,currency,created_at')
    .eq('payment_environment', adminConfig.analytics.paymentEnvironment)
    .in('status', ['completed', 'active', 'trialing', 'past_due', 'canceled'])
    .gt('amount_cents', 0)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/revenue] fetchOneTimeOrders failed:', error?.message);
    throw new Error('Order revenue source is unavailable.');
  }
  return data as OrderTimeRow[];
}

async function fetchRenewals({ from, to }: DateRange): Promise<RenewalRow[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('renewal_events')
    .select('amount_cents,currency,created_at')
    .eq('payment_environment', adminConfig.analytics.paymentEnvironment)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/revenue] fetchRenewals failed:', error?.message);
    throw new Error('Renewal revenue source is unavailable.');
  }
  return data as RenewalRow[];
}

export async function grossRevenueInEurInRange(range: DateRange): Promise<number> {
  const orders = await fetchOneTimeOrders(range);
  return orders.reduce((sum, r) => sum + convertToEur(r.amount_cents, r.currency), 0);
}

export async function revenueByCurrencyInRange(
  range: DateRange,
): Promise<Record<string, number>> {
  const orders = await fetchOneTimeOrders(range);
  const out: Record<string, number> = {};
  for (const r of orders) {
    const code = (r.currency ?? 'eur').toUpperCase();
    out[code] = (out[code] ?? 0) + r.amount_cents;
  }
  return out;
}

export async function renewalRevenueInEur(range: DateRange): Promise<number> {
  const renewals = await fetchRenewals(range);
  return renewals.reduce((sum, r) => sum + convertToEur(r.amount_cents, r.currency), 0);
}

/**
 * All-time realized net customer LTV for production payments.
 *
 * The database aggregate keeps customer-level payment rows inside Postgres and
 * returns only one total per currency plus the deduplicated customer count.
 * Orders and renewal_events both store the current net amount after refunds and
 * chargebacks, so this is realized net value rather than a forecast.
 */
export async function averageCustomerLtvEur(): Promise<AverageCustomerLtvMetric> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc('admin_customer_ltv_by_currency_v2', {
    p_payment_environment: adminConfig.analytics.paymentEnvironment,
  });
  if (error || !data) {
    console.error('[admin/revenue] averageCustomerLtvEur failed:', error?.message);
    return {
      averageNetLtvEurCents: 0,
      customerCount: 0,
      totalNetRevenueEurCents: 0,
      warning: 'Average customer LTV is unavailable. Apply the admin core migration.',
    };
  }

  const customerCount = data.reduce(
    (max, row) => Math.max(max, Number(row.customer_count) || 0),
    0,
  );
  let totalNetRevenueEurCents: number;
  try {
    totalNetRevenueEurCents = data.reduce(
      (sum, row) =>
        sum +
        convertToEur(
          Number(row.net_amount_cents) || 0,
          (row.currency as string | null) ?? 'eur',
        ),
      0,
    );
  } catch (error) {
    if (!(error instanceof MissingAdminFxRateError)) throw error;
    return {
      averageNetLtvEurCents: 0,
      customerCount,
      totalNetRevenueEurCents: 0,
      warning: `${error.message}. Configure ADMIN_FX_RATES before using LTV.`,
    };
  }

  return {
    averageNetLtvEurCents:
      customerCount > 0
        ? Math.round(totalNetRevenueEurCents / customerCount)
        : 0,
    customerCount,
    totalNetRevenueEurCents,
    warning: null,
  };
}

export async function revenueTimeSeriesInEur(
  range: DateRange,
): Promise<Array<{ date: string; value: number }>> {
  const [orders, renewals] = await Promise.all([
    fetchOneTimeOrders(range),
    fetchRenewals(range),
  ]);
  const bucket = new Map<string, number>();
  const add = (ts: string, value: number) => {
    const day = new Date(ts).toISOString().slice(0, 10);
    bucket.set(day, (bucket.get(day) ?? 0) + value);
  };
  for (const o of orders) add(o.created_at, convertToEur(o.amount_cents, o.currency));
  for (const r of renewals) add(r.created_at, convertToEur(r.amount_cents, r.currency));
  return [...bucket.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
