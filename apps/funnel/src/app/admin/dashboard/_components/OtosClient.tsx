'use client';

// D-19: client wrapper for the OTOs tab. Same pattern as siblings.
// Payload shape matches refetchOtos: {counts, rates}.

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { refetchOtos } from '../_actions/refetch-otos';

export type OtosPayload = {
  counts: Array<{
    offer: string;
    pattern: string;
    count: number;
    amountEurCents: number | null;
  }>;
  rates: Array<{ offer: string; takeRate: number }>;
};

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

function eur(cents: number | null) {
  if (cents === null) return 'FX unavailable';
  return `€${(cents / 100).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`;
}

export function OtosClient({ initialData }: { initialData: OtosPayload }) {
  const [data, setData] = useState<OtosPayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      setError(null);
      try {
        const fresh = await refetchOtos(range);
        setData(fresh);
      } catch (e) {
        setError('Report could not be refreshed. The previous range is still shown.');
        console.error('[admin/otos] refetch failed:', e);
      }
    });
  };

  const rateMap = new Map(data.rates.map((r) => [r.offer, r.takeRate]));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">OTOs</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">OTO offers</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1">Offer</th>
              <th className="py-1">Count</th>
              <th className="py-1">Initial net (EUR estimate)</th>
              <th className="py-1">Take rate</th>
            </tr>
          </thead>
          <tbody>
            {data.counts.map((c) => (
              <tr key={c.offer} className="border-t border-neutral-100">
                <td className="py-1">{c.offer}</td>
                <td className="py-1">{c.count}</td>
                <td className="py-1">{eur(c.amountEurCents)}</td>
                <td className="py-1">
                  {((rateMap.get(c.offer) ?? 0) * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
