'use client';

// D-19: client wrapper for the Revenue tab. Mirrors SessionsClient pattern.
// Initial data is server-rendered by RevenueTab; subsequent date-range Apply
// calls go through refetchRevenue (which re-checks isAdminEmail + runs the
// period revenue aggregations and all-time realized LTV in parallel).

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { TimeSeriesLine } from './charts/TimeSeriesLine';
import { refetchRevenue } from '../_actions/refetch-revenue';
import type { AdminDataResult } from '@repo/admin-core/result';
import type { SupabaseSolidgateRevenueSnapshot } from '@/features/admin/adapters/supabase-solidgate';

export type RevenuePayload = AdminDataResult<SupabaseSolidgateRevenueSnapshot>;

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

function eur(cents: number, fractionDigits = 0) {
  return `€${(cents / 100).toLocaleString('en-IE', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function RevenueClient({ initialData }: { initialData: RevenuePayload }) {
  const [data, setData] = useState<RevenuePayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      try {
        const fresh = await refetchRevenue(range);
        setData(fresh);
      } catch (e) {
        console.error('[admin/revenue] refetch failed:', e);
      }
    });
  };

  const snapshot = data.data;
  const total = snapshot.oneTimeEur + snapshot.renewalEur;
  const unavailable = data.status === 'unavailable';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Revenue</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>
      {data.warnings.length > 0 ? (
        <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {data.warnings.map((warning) => warning.message).join(' ')}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-neutral-700">
            Total revenue (EUR)
          </h3>
          <div className="text-3xl font-semibold text-neutral-900">
            {unavailable ? 'Unavailable' : eur(total)}
          </div>
          <div className="mt-2 text-xs text-neutral-500">
            One-time + OTO: {unavailable ? '—' : eur(snapshot.oneTimeEur)} · Renewals:{' '}
            {unavailable ? '—' : eur(snapshot.renewalEur)}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-neutral-700">
            Average customer LTV (EUR)
          </h3>
          <div className="text-3xl font-semibold text-neutral-900">
            {snapshot.averageCustomerLtv.warning
              ? 'Unavailable'
              : eur(snapshot.averageCustomerLtv.averageNetLtvEurCents, 2)}
          </div>
          <div className="mt-2 text-xs text-neutral-500">
            {snapshot.averageCustomerLtv.customerCount.toLocaleString()} paying
            customers · {snapshot.averageCustomerLtv.warning ? '—' : eur(snapshot.averageCustomerLtv.totalNetRevenueEurCents)} net
            lifetime revenue
          </div>
          <div className="mt-2 text-xs text-neutral-400">
            All production history · net captured orders and renewals after
            refunds and chargebacks ÷ distinct customer identities.
          </div>
          {snapshot.averageCustomerLtv.warning ? (
            <div
              role="status"
              className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {snapshot.averageCustomerLtv.warning}
            </div>
          ) : null}
        </div>
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Revenue time series (EUR / day)
        </h3>
        <TimeSeriesLine data={snapshot.timeSeries} yLabel="EUR cents" color="#10b981" />
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Per-currency breakdown (raw, one-time only)
        </h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1">Currency</th>
              <th className="py-1">Total (as stored — cents; JPY whole yen)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(snapshot.byCurrency).map(([code, amt]) => (
              <tr key={code} className="border-t border-neutral-100">
                <td className="py-1">{code}</td>
                <td className="py-1">{amt.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
