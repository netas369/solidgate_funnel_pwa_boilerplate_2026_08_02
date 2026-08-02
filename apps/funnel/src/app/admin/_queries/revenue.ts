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
import { convertToEur } from './fx';
import type { DateRange } from './_shared';

type OrderRow = { amount_cents: number; currency: string };
type RenewalRow = { amount_cents: number; currency: string; created_at: string };
type OrderTimeRow = OrderRow & { created_at: string };

async function fetchOneTimeOrders({ from, to }: DateRange): Promise<OrderTimeRow[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('orders')
    .select('amount_cents,currency,created_at')
    .eq('payment_environment', 'production')
    .in('status', ['completed', 'active', 'trialing', 'past_due', 'canceled'])
    .gt('amount_cents', 0)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/revenue] fetchOneTimeOrders failed:', error?.message);
    return [];
  }
  return data as OrderTimeRow[];
}

async function fetchRenewals({ from, to }: DateRange): Promise<RenewalRow[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('renewal_events')
    .select('amount_cents,currency,created_at')
    .eq('payment_environment', 'production')
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/revenue] fetchRenewals failed:', error?.message);
    return [];
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
