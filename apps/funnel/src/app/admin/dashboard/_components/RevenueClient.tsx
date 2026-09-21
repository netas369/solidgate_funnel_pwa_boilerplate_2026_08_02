'use client';

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { TimeSeriesLine } from './charts/TimeSeriesLine';
import { refetchRevenue } from '../_actions/refetch-revenue';
import type { RevenueSummary } from '../../_queries/revenue';

export type RevenuePayload = RevenueSummary;
function eur(cents: number | null) {
  return cents === null ? 'Unavailable' : `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function RevenueClient({ initialData }: { initialData: RevenuePayload }) {
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const now = new Date();
  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      setError(null);
      try { setData(await refetchRevenue(range)); }
      catch { setError('Report could not be refreshed. The previous range is still shown.'); }
    });
  };
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Revenue</h2>
        <DateRangePicker initialFrom={subDays(now, 30).toISOString().slice(0, 10)} initialTo={now.toISOString().slice(0, 10)} onApply={onApply} disabled={isPending} />
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {data.missingFxCurrencies.length > 0 && <p role="status" className="text-sm text-amber-800">EUR estimate unavailable: configure FX rates for {data.missingFxCurrencies.join(', ')}. Exact amounts by currency are shown below.</p>}
      {data.estimatedTimingMovements > 0 && <p className="text-xs text-neutral-500">{data.estimatedTimingMovements} movements use provider event or observation dates because an exact transaction timestamp was not available.</p>}
      {data.legacyMovements > 0 && <p className="text-sm text-amber-800">This range includes {data.legacyMovements} historical balance imports. Their observation dates may differ from the original payment or refund dates; provider reconciliation is required.</p>}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-medium text-neutral-700">Net collections — EUR estimate</h3>
        <div className="text-3xl font-semibold text-neutral-900">{eur(data.totalEur)}</div>
        <p className="mt-2 text-xs text-neutral-500">Initial payments: {eur(data.oneTimeEur)} · Renewals: {eur(data.renewalEur)}</p>
        <p className="mt-2 text-xs text-neutral-500">Captured: {eur(data.grossEur)} · Refunds: {eur(data.refundsEur)} · Dispute reserve changes: {eur(data.chargebacksEur)}</p>
        <p className="mt-2 text-xs text-neutral-500">Payment and reversal movements in the selected UTC range. Fees, payouts and settlement FX are excluded. Refunds overlapping a dispute are deducted once.</p>
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">Net collections by event date — EUR estimate / day</h3>
        {data.missingFxCurrencies.length === 0 && <TimeSeriesLine data={data.timeSeries} yLabel="EUR cents" color="#10b981" />}
      </div>
      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">Initial payments and renewals by currency</h3>
        <p className="mb-2 text-xs text-neutral-500">Exact native minor units (JPY: whole yen).</p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500"><tr>
            {['Currency', 'Captured', 'Refunds', 'Dispute reserve change', 'Net'].map(label => <th key={label} className="py-1 pr-3">{label}</th>)}
          </tr></thead>
          <tbody>{data.currencyTotals.map(row => <tr key={row.currency} className="border-t border-neutral-100">
            <td className="py-1">{row.currency}</td>
            {[row.captured, row.refunded, row.chargeback, row.net].map((value, index) => <td key={index} className="py-1">{value.toLocaleString()}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
