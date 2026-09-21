'use client';

// D-12: custom two-input date-range picker. NO third-party calendar lib —
// plain <input type="date"> + Apply button. Apply converts the YYYY-MM-DD
// inputs to ISO datetimes: `from` becomes UTC midnight at the picked day,
// `to` becomes UTC midnight at the day AFTER the picked day so the user-
// inclusive "to" maps to the exclusive upper bound used by DateRange in
// _queries/_shared.ts.
//
// Apply is disabled until both inputs are set and from <= to. The inclusive end date becomes the
// following UTC midnight, satisfying the server-side exclusive range.

import { useState } from 'react';

export interface DateRangePickerProps {
  initialFrom: string; // YYYY-MM-DD
  initialTo: string; // YYYY-MM-DD
  onApply: (range: { from: string; to: string }) => void; // ISO datetimes
  disabled?: boolean;
}

export function DateRangePicker({
  initialFrom,
  initialTo,
  onApply,
  disabled = false,
}: DateRangePickerProps) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const canApply = Boolean(from) && Boolean(to) && from <= to;

  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-neutral-600">
        From
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          disabled={disabled}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-neutral-600">
        To
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          disabled={disabled}
        />
      </label>
      <button
        type="button"
        disabled={disabled || !canApply}
        onClick={() => {
          // Convert YYYY-MM-DD to ISO datetimes at UTC midnight.
          const fromIso = new Date(`${from}T00:00:00Z`).toISOString();
          // `to` is INCLUSIVE in the user's mental model; convert to the
          // exclusive upper bound (start of the next UTC day) so the SQL
          // gte/lt filters in _queries/* return the full picked day.
          const toDate = new Date(`${to}T00:00:00Z`);
          toDate.setUTCDate(toDate.getUTCDate() + 1);
          const toIso = toDate.toISOString();
          onApply({ from: fromIso, to: toIso });
        }}
        className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  );
}
