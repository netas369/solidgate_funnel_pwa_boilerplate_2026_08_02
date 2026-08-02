'use client';

// Client wrapper for the Subscriptions tab. Same pattern as siblings.
// Payload shape matches refetchSubscriptions.

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { refetchSubscriptions } from '../_actions/refetch-subscriptions';
import type {
  SubscriptionStatusBreakdown,
  SubscriptionVariantBreakdown,
} from '../../_queries/subscriptions';

export type SubscriptionsPayload = {
  cohort: { cohortSize: number; converted: number; ratePct: number };
  rolling: { numerator: number; denominator: number; ratePct: number };
  recurringOto: {
    activeCount: number;
    estimatedMrrEurCents: number;
    renewalRevenueEurCents: number;
    sample?: Array<{
      user_id: string;
      expires_at: string | null;
      product_slug: string;
    }>;
  };
  statusBreakdown: SubscriptionStatusBreakdown;
  variantBreakdown: SubscriptionVariantBreakdown;
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

export function SubscriptionsClient({
  initialData,
}: {
  initialData: SubscriptionsPayload;
}) {
  const [data, setData] = useState<SubscriptionsPayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      try {
        const fresh = await refetchSubscriptions(range);
        setData(fresh);
      } catch (e) {
        console.error('[admin/subscriptions] refetch failed:', e);
      }
    });
  };

  const {
    cohort,
    rolling,
    recurringOto,
    statusBreakdown: sb,
    variantBreakdown: vb,
  } = data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Subscriptions</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>

      {/* Plain-language status snapshot of plan subscriptions started in range.
          Each subscription is one order row whose status the Solidgate webhook
          updates in place, so these counts are where each one stands now. */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-neutral-700">
            Plan subscriptions — current status
          </h3>
          <span className="text-xs text-neutral-500">
            {sb.total} started in range
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatusCard
            label="In free trial"
            value={sb.trialing}
            hint="Not charged yet"
            tone="neutral"
          />
          <StatusCard
            label="Active — paying"
            value={sb.active}
            hint="Trial converted"
            tone="good"
          />
          <StatusCard
            label="Payment failed"
            value={sb.pastDue}
            hint="Past due / retrying"
            tone="warn"
          />
          <StatusCard
            label="Canceled"
            value={sb.canceled}
            hint="Subscription ended"
            tone="muted"
          />
        </div>
        {sb.other > 0 && (
          <div className="mt-2 text-xs text-neutral-400">
            {sb.other} order(s) in another status (pending / failed / refunded).
          </div>
        )}
      </div>

      {/* Which page sold each subscription. Every checkout tier shares one
          product code, so the split comes from the Solidgate order id. */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-neutral-700">
            Plan subscriptions — where they came from
          </h3>
          <span className="text-xs text-neutral-500">
            {vb.total} started in range
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatusCard
            label="Main funnel"
            value={vb.main}
            hint="Quiz → /offer (trial 1–4)"
            tone="neutral"
          />
          <StatusCard
            label="Special €1"
            value={vb.special1eur}
            hint="/special-offer"
            tone="neutral"
          />
          <StatusCard
            label="Special FREE"
            value={vb.specialFree}
            hint="/special-offer-free"
            tone="neutral"
          />
          <StatusCard
            label="Unattributed"
            value={vb.legacy}
            hint="No parseable order id"
            tone="muted"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* D-13: cohort headline (larger) + rolling secondary side-by-side. */}
        <div className="rounded-lg border border-neutral-200 bg-white p-6">
          <h3 className="mb-2 text-sm font-medium text-neutral-700">
            Trial-to-paid (cohort)
          </h3>
          <div className="text-4xl font-semibold text-neutral-900">
            {cohort.ratePct.toFixed(1)}%
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {cohort.converted} of {cohort.cohortSize} trials converted (7d+ retention)
          </div>
          <div className="mt-2 text-xs text-neutral-400">
            Share of trials started in range that stayed paid for 7+ days. Reads
            0% until trials are old enough to have a confirmed renewal.
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="mb-2 text-xs font-medium text-neutral-700">
            Rolling conversion
          </h3>
          <div className="text-2xl font-semibold text-neutral-900">
            {rolling.ratePct.toFixed(1)}%
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {rolling.numerator} / {rolling.denominator}
          </div>
          <div className="mt-2 text-xs text-neutral-400">
            Active subscriptions ÷ all trials started in range.
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-medium text-neutral-700">
          Recurring OTO subscriptions
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs uppercase text-neutral-500">Active</div>
            <div className="text-2xl font-semibold">{recurringOto.activeCount}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-neutral-500">
              Estimated MRR (EUR)
            </div>
            <div className="text-2xl font-semibold">
              {eur(recurringOto.estimatedMrrEurCents)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-neutral-500">
              Renewals in window (EUR)
            </div>
            <div className="text-2xl font-semibold">
              {eur(recurringOto.renewalRevenueEurCents)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type StatusTone = 'neutral' | 'good' | 'warn' | 'muted';

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'text-neutral-900',
  good: 'text-emerald-700',
  warn: 'text-amber-600',
  muted: 'text-neutral-500',
};

function StatusCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: StatusTone;
}) {
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 text-3xl font-semibold ${STATUS_TONE_CLASS[tone]}`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-neutral-400">{hint}</div>
    </div>
  );
}
