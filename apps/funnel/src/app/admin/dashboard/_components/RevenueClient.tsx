'use client';

// D-19: client wrapper for the Revenue tab. Mirrors SessionsClient pattern.
// Initial data is server-rendered by RevenueTab; subsequent date-range Apply
// calls go through refetchRevenue (which re-checks isAdminEmail + runs the
// 4 EUR aggregations in parallel).

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { TimeSeriesLine } from './charts/TimeSeriesLine';
import { refetchRevenue } from '../_actions/refetch-revenue';

export type RevenuePayload = {
  oneTimeEur: number;
  renewalEur: number;
  byCurrency: Record<string, number>;
  timeSeries: Array<{ date: string; value: number }>;
};

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

function eur(cents: number) {
  return `€${(cents / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`;
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

  const total = data.oneTimeEur + data.renewalEur;

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
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-medium text-neutral-700">
          Total revenue (EUR)
        </h3>
        <div className="text-3xl font-semibold text-neutral-900">{eur(total)}</div>
        <div className="mt-2 text-xs text-neutral-500">
          One-time + OTO: {eur(data.oneTimeEur)} · Renewals: {eur(data.renewalEur)}
        </div>
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Revenue time series (EUR / day)
        </h3>
        <TimeSeriesLine data={data.timeSeries} yLabel="EUR cents" color="#10b981" />
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
            {Object.entries(data.byCurrency).map(([code, amt]) => (
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
