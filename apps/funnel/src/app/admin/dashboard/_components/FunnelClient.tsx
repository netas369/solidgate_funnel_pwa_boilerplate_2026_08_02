'use client';

// Client wrapper for the Funnel tab. Same pattern as the sibling tabs:
// receives a server-fetched 30d snapshot, owns the date-range state, and
// re-runs the queries via the refetch-funnel action on Apply.

import { useState, useTransition } from 'react';
import { subDays } from 'date-fns';
import { DateRangePicker } from './DateRangePicker';
import { TimeSeriesLine } from './charts/TimeSeriesLine';
import { HorizontalBar } from './charts/HorizontalBar';
import { refetchFunnel } from '../_actions/refetch-funnel';
import type {
  StepFunnelRow,
  FunnelStageSummary,
  LocaleBreakdownRow,
} from '../../_queries/funnel';

export type FunnelPayload = {
  steps: StepFunnelRow[];
  summary: FunnelStageSummary;
  byLocale: LocaleBreakdownRow[];
};

function defaultDateStrings() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = subDays(now, 30).toISOString().slice(0, 10);
  return { from, to };
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Tailwind text colour for a drop-off percentage. */
function dropColor(dropPct: number): string {
  if (dropPct >= 25) return 'text-red-600 font-medium';
  if (dropPct >= 10) return 'text-amber-600';
  return 'text-neutral-600';
}

export function FunnelClient({ initialData }: { initialData: FunnelPayload }) {
  const [data, setData] = useState<FunnelPayload>(initialData);
  const [isPending, startTransition] = useTransition();
  const init = defaultDateStrings();

  const onApply = (range: { from: string; to: string }) => {
    startTransition(async () => {
      try {
        const fresh = await refetchFunnel(range);
        setData(fresh);
      } catch (e) {
        console.error('[admin/funnel] refetch failed:', e);
      }
    });
  };

  const { steps, summary, byLocale } = data;

  // Branch positions: quiz-config gives two alternative steps the SAME
  // position when a visitor traverses one of them, not both. Their completion
  // counts are therefore split across two paths and their apparent "drop" is
  // an artefact. Empty for a purely linear quiz.
  const branchPositions = new Set(
    steps
      .map((s) => s.position)
      .filter((p, i, all) => all.indexOf(p) !== i),
  );

  // Worst non-branching drop-off step, surfaced as a callout.
  const realDrops = steps.filter((s) => !branchPositions.has(s.position));
  const worstDrop = realDrops.reduce<StepFunnelRow | null>(
    (worst, s) =>
      worst === null || s.dropPctFromPrev > worst.dropPctFromPrev ? s : worst,
    null,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium text-neutral-800">Quiz funnel</h2>
        <DateRangePicker
          initialFrom={init.from}
          initialTo={init.to}
          onApply={onApply}
          disabled={isPending}
        />
      </div>

      {/* ── Stage summary ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Quiz started
          </div>
          <div className="mt-1 text-3xl font-semibold text-neutral-900">
            {summary.started}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            Sessions created in range
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Emails captured
          </div>
          <div className="mt-1 text-3xl font-semibold text-emerald-700">
            {summary.leads}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {pct(summary.leads, summary.started)} of started · leads
          </div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-500">
            Quiz completed
          </div>
          <div className="mt-1 text-3xl font-semibold text-neutral-900">
            {summary.quizCompleted}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            {pct(summary.quizCompleted, summary.started)} of started
          </div>
        </div>
      </div>

      {/* ── Step drop-off curve ───────────────────────────────────────── */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-neutral-700">
            Step drop-off — completions per step
          </h3>
          {worstDrop && worstDrop.dropPctFromPrev > 0 && (
            <span className="text-xs text-neutral-500">
              Biggest drop:{' '}
              <span className="font-medium text-red-600">
                step {worstDrop.position} ({worstDrop.type}) −
                {worstDrop.dropPctFromPrev.toFixed(1)}%
              </span>
            </span>
          )}
        </div>
        <TimeSeriesLine
          data={steps.map((s) => ({
            date: String(s.position),
            value: s.completed,
          }))}
          yLabel="Completions"
          color="#6366f1"
        />
        {branchPositions.size > 0 && (
          <p className="mt-2 text-xs text-neutral-400">
            Step{branchPositions.size > 1 ? 's' : ''}{' '}
            {[...branchPositions].sort((a, b) => a - b).join(', ')} branch, so
            their counts split across two paths.
          </p>
        )}
      </div>

      {/* ── Per-step table ────────────────────────────────────────────── */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          Step-by-step breakdown
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="py-1 pr-3">Step</th>
                <th className="py-1 pr-3">Phase</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1 pr-3 text-right">Completed</th>
                <th className="py-1 pr-3 text-right">Drop</th>
                <th className="py-1 text-right">Drop %</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr
                  key={s.stepId}
                  className={
                    s.type === 'email_capture'
                      ? 'border-t border-neutral-100 bg-emerald-50/60'
                      : 'border-t border-neutral-100'
                  }
                >
                  <td className="py-1 pr-3 font-medium text-neutral-800">
                    {s.position}
                  </td>
                  <td className="py-1 pr-3 text-neutral-600">{s.phase || '—'}</td>
                  <td className="py-1 pr-3 text-neutral-600">{s.type}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {s.completed}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-neutral-500">
                    {s.position === steps[0]?.position ? '—' : s.dropFromPrev}
                  </td>
                  <td
                    className={`py-1 text-right tabular-nums ${
                      s.position === steps[0]?.position
                        ? 'text-neutral-400'
                        : dropColor(s.dropPctFromPrev)
                    }`}
                  >
                    {s.position === steps[0]?.position
                      ? '—'
                      : `${s.dropPctFromPrev.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── By locale ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium text-neutral-700">
          By locale
        </h3>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="py-1 pr-3">Locale</th>
              <th className="py-1 pr-3 text-right">Sessions</th>
              <th className="py-1 pr-3 text-right">Leads</th>
              <th className="py-1 pr-3 text-right">Lead rate</th>
              <th className="py-1 text-right">Subscriptions</th>
            </tr>
          </thead>
          <tbody>
            {byLocale.length === 0 && (
              <tr>
                <td className="py-2 text-neutral-400" colSpan={5}>
                  No data in range.
                </td>
              </tr>
            )}
            {byLocale.map((l) => (
              <tr key={l.locale} className="border-t border-neutral-100">
                <td className="py-1 pr-3 font-medium text-neutral-800">
                  {l.locale}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">
                  {l.sessions}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{l.leads}</td>
                <td className="py-1 pr-3 text-right tabular-nums text-neutral-600">
                  {l.leadRatePct.toFixed(1)}%
                </td>
                <td className="py-1 text-right tabular-nums">
                  {l.subscriptions}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">
            Leads by locale
          </h3>
          <HorizontalBar
            data={byLocale.map((l) => ({ label: l.locale, value: l.leads }))}
          />
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">
            Subscriptions by locale
          </h3>
          <HorizontalBar
            data={byLocale.map((l) => ({
              label: l.locale,
              value: l.subscriptions,
            }))}
            color="#0ea5e9"
          />
        </div>
      </div>
    </div>
  );
}
