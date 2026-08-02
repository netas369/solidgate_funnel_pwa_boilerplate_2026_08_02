// D-12 + D-15: async Server Component computing 9 numbers in parallel
// (3 metrics × 3 fixed buckets) and rendering 3 KpiCards side-by-side.
// All time math is UTC via date-fns (matches _queries/_shared.ts DateRange
// contract — `from` inclusive, `to` exclusive).
//
// This row IGNORES the date-range picker added in Plan 06 — D-12 mandates
// fixed Today/7d/30d buckets so the owner always sees baseline pulse.

import { subDays, startOfDay, formatISO } from 'date-fns';
import { countSessionsInRange } from '../../_queries/sessions';
import { countLeadsInRange } from '../../_queries/leads';
import { grossRevenueInEurInRange } from '../../_queries/revenue';
import type { DateRange } from '../../_queries/_shared';
import { KpiCard } from './KpiCard';

function buckets(): {
  today: DateRange;
  sevenD: DateRange;
  thirtyD: DateRange;
} {
  const now = new Date();
  const startToday = startOfDay(now);
  const nowIso = formatISO(now);
  return {
    today: { from: formatISO(startToday), to: nowIso },
    sevenD: { from: formatISO(subDays(startToday, 7)), to: nowIso },
    thirtyD: { from: formatISO(subDays(startToday, 30)), to: nowIso },
  };
}

function fmtEur(cents: number): string {
  return `€${(cents / 100).toLocaleString('en-IE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export async function KpiCardsRow() {
  const b = buckets();
  // Promise.all parallelizes 9 lightweight count queries — Supabase handles
  // each as a separate `count: 'exact', head: true` round trip, so total
  // latency is roughly 1× slowest query, not 9× sequential.
  const [tS, wS, mS, tL, wL, mL, tR, wR, mR] = await Promise.all([
    countSessionsInRange(b.today),
    countSessionsInRange(b.sevenD),
    countSessionsInRange(b.thirtyD),
    countLeadsInRange(b.today),
    countLeadsInRange(b.sevenD),
    countLeadsInRange(b.thirtyD),
    grossRevenueInEurInRange(b.today),
    grossRevenueInEurInRange(b.sevenD),
    grossRevenueInEurInRange(b.thirtyD),
  ]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <KpiCard
        label="Sessions"
        today={String(tS)}
        sevenD={String(wS)}
        thirtyD={String(mS)}
      />
      <KpiCard
        label="Leads"
        today={String(tL)}
        sevenD={String(wL)}
        thirtyD={String(mL)}
      />
      <KpiCard
        label="Revenue (EUR)"
        today={fmtEur(tR)}
        sevenD={fmtEur(wR)}
        thirtyD={fmtEur(mR)}
      />
    </div>
  );
}
