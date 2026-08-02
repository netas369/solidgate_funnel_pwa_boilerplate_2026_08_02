'use client';

// Client wrapper for the Customers tab: a newest-first table of buyers with
// email, product, status, amount and the Solidgate subscription id. Same
// date-range + useTransition refetch pattern as the sibling tabs.

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { refetchCustomers } from '../_actions/refetch-customers';
import type { CustomerOrderRow } from '../../_queries/customers';

export type CustomersPayload = {
  orders: CustomerOrderRow[];
};

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

/** Tailwind classes for an order-status badge. */
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active':
    case 'completed':
      return 'bg-emerald-100 text-emerald-800';
    case 'trialing':
      return 'bg-sky-100 text-sky-800';
    case 'past_due':
      return 'bg-amber-100 text-amber-800';
    case 'failed':
    case 'refunded':
    case 'disputed':
      return 'bg-red-100 text-red-800';
    case 'canceled':
      return 'bg-neutral-200 text-neutral-600';
    default:
      return 'bg-neutral-100 text-neutral-600';
  }
}

/** "2026-05-21 14:30" in UTC — matches the admin "all dates UTC" contract. */
function fmtDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

function fmtAmount(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  // JPY has no minor unit — orders store whole yen, on both PSPs.
  if (code === 'JPY') return `${cents} ${code}`;
  return `${(cents / 100).toFixed(2)} ${code}`;
}

export function CustomersClient({
  initialData,
}: {
  initialData: CustomersPayload;
}) {
  const [data, setData] = useState<CustomersPayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      try {
        const fresh = await refetchCustomers(range);
        setData(fresh);
      } catch (e) {
        console.error('[admin/customers] refetch failed:', e);
      }
    });
  };

  const { orders } = data;
  const subCount = orders.filter((o) => o.isSubscription).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Customers</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-neutral-700">
            Recent buyers
          </h3>
          <span className="text-xs text-neutral-500">
            {orders.length} order(s) · {subCount} subscription(s) · newest first
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-1 pr-3">Date (UTC)</th>
                <th className="py-1 pr-3">Email</th>
                <th className="py-1 pr-3">Product</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3 text-right">Amount</th>
                <th className="py-1 pr-3">Locale</th>
                <th className="py-1">Subscription ID</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td className="py-2 text-neutral-400" colSpan={7}>
                    No orders in range.
                  </td>
                </tr>
              )}
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-neutral-100">
                  <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-neutral-600">
                    {fmtDate(o.createdAt)}
                  </td>
                  <td className="py-1 pr-3 text-neutral-800">
                    {o.email ?? <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="py-1 pr-3 text-neutral-600">
                    {o.productName}
                  </td>
                  <td className="py-1 pr-3">
                    <span
                      className={`inline-block rounded px-1.5 py-0.5 text-xs ${statusBadgeClass(
                        o.status,
                      )}`}
                    >
                      {o.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3 text-right tabular-nums">
                    {fmtAmount(o.amountCents, o.currency)}
                  </td>
                  <td className="py-1 pr-3 text-neutral-600">
                    {o.locale ?? '—'}
                  </td>
                  <td className="py-1 font-mono text-xs text-neutral-500">
                    {o.subscriptionId ?? (
                      <span className="text-neutral-300">— one-time</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-neutral-400">
          Email is the address captured during the quiz for that session.
          Showing up to 200 most recent orders in range.
        </p>
      </div>
    </div>
  );
}
