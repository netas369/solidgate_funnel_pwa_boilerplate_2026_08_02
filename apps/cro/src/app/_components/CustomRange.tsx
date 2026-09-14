'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { filterHref, windowFloor, todayIso, type DashboardFilters } from '@/lib/filters';

/**
 * A hand-picked window, for the questions the three presets cannot answer:
 * "the week we changed Q6", or last month against the month before it.
 *
 * Client only because two date inputs need to be filled in before anything
 * happens — a link cannot hold a half-entered form. The state it owns is the
 * DRAFT; the moment Apply is pressed it goes into the URL like every other
 * filter, so the result is still bookmarkable and still survives the live
 * board's auto-refresh. Nothing on the board reads from this component.
 */
export function CustomRange({
  filters,
  basePath,
}: {
  filters: DashboardFilters;
  basePath: string;
}) {
  const router = useRouter();
  const today = todayIso();
  const floor = windowFloor();

  const [from, setFrom] = useState(filters.from ?? '');
  const [to, setTo] = useState(filters.to ?? '');

  const complete = Boolean(from && to);
  // The browser's own min/max stop most of it, but a typed date bypasses the
  // picker entirely. parseFilters clamps server-side regardless; this only keeps
  // the button from promising a window it will not get.
  const valid = complete && from <= to;

  function apply() {
    if (!valid) return;
    router.push(filterHref(basePath, filters, { from, to }));
  }

  return (
    <form
      className="flex flex-wrap items-center gap-1"
      aria-label="Custom period"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <DateField label="From" value={from} min={floor} max={today} onChange={setFrom} />
      <span className="text-xs text-ink-faint">to</span>
      <DateField label="To" value={to} min={floor} max={today} onChange={setTo} />
      <button
        type="submit"
        disabled={!valid}
        className="rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-40"
        style={{ background: 'var(--paper)', color: 'var(--ink-soft)' }}
      >
        Apply
      </button>
    </form>
  );
}

function DateField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md px-2 py-2 text-xs tabular-nums"
        style={{ background: 'var(--paper)', color: 'var(--ink)' }}
      />
    </label>
  );
}
