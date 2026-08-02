'use client';

// D-19: client wrapper that owns the current date range + tab data state.
// Receives initial server-fetched data from SessionsTab (Server Component)
// so first paint matches the Server Component snapshot. On Apply:
//   - useTransition keeps the existing UI interactive while the action runs
//   - refetchSessions(range) re-runs SQL server-side under the cookie identity
//   - setData replaces the tab payload; React re-renders without a router
//     refresh (T-06-07: TabShell active-tab state is preserved).

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { TimeSeriesLine } from './charts/TimeSeriesLine';
import { HorizontalBar } from './charts/HorizontalBar';
import { refetchSessions } from '../_actions/refetch-sessions';

export type SessionsPayload = {
  timeSeries: Array<{ date: string; count: number }>;
  byLocale: Array<{ locale: string; count: number; sharePct: number }>;
};

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

export function SessionsClient({ initialData }: { initialData: SessionsPayload }) {
  const [data, setData] = useState<SessionsPayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      try {
        const fresh = await refetchSessions(range);
        setData(fresh);
      } catch (e) {
        console.error('[admin/sessions] refetch failed:', e);
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Sessions</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Sessions over time
        </h3>
        <TimeSeriesLine
          data={data.timeSeries.map((d) => ({ date: d.date, value: d.count }))}
          yLabel="Sessions"
        />
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Sessions by locale
        </h3>
        <HorizontalBar
          data={data.byLocale.map((d) => ({ label: d.locale, value: d.count }))}
        />
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1">Locale</th>
              <th className="py-1">Count</th>
              <th className="py-1">Share %</th>
            </tr>
          </thead>
          <tbody>
            {data.byLocale.map((d) => (
              <tr key={d.locale} className="border-t border-neutral-100">
                <td className="py-1">{d.locale}</td>
                <td className="py-1">{d.count}</td>
                <td className="py-1">{d.sharePct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
