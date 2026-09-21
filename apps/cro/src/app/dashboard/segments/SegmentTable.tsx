import { barWidthPct, formatPct, formatPeople } from '@/lib/presentation';
import type { SegmentRow } from '@/lib/queries';

/**
 * One dimension's breakdown: who they were, how many, and how far they got.
 *
 * A TABLE PER DIMENSION, never a cross product. The references cross language
 * with device into one list, which reads fine at two locales and becomes
 * thousands of one-session rows at fifteen locales times four devices times
 * forty countries — and each of those rows is a quasi-identifier for a single
 * visitor. cro_segment_breakdown takes one dimension per call for the same
 * reason.
 *
 * The bars are scaled within this table alone. Sharing a scale across
 * dimensions would be meaningless: "mobile" and "English" are not competing for
 * the same visitors.
 */
/**
 * The typical question a group reached, worded so it names a real question.
 *
 * cro_segment_breakdown uses percentile_cont on purpose: a group split between
 * positions 3 and 4 has a true median of 3.5, and rounding it in SQL would
 * throw away an eighth of a seven-step funnel. But "question 3.5" is a question
 * that does not exist, so the interval is what gets rendered — the precision
 * stays in the data and the screen stays honest.
 */
function medianQuestion(value: number | null): string {
  if (value === null) return '—';
  if (Number.isInteger(value)) return `question ${value}`;
  return `question ${Math.floor(value)}\u2013${Math.ceil(value)}`;
}

export function SegmentTable({
  title,
  hint,
  rows,
  label,
}: {
  title: string;
  hint: string;
  rows: SegmentRow[];
  /** How a bucket code reads on screen — a locale code, a device name. */
  label: (bucket: string) => string;
}) {
  if (rows.length === 0) return null;

  const busiest = rows.reduce((max, r) => Math.max(max, r.sessions), 0);
  const deepest = rows.reduce((max, r) => Math.max(max, r.median_max_position ?? 0), 0);
  const total = rows.reduce((sum, r) => sum + r.sessions, 0);

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-hairline px-4 py-3">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="mt-1 text-xs text-ink-faint">{hint}</p>
      </div>

      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-hairline px-4 py-2">
        <span className="label-eyebrow">Group</span>
        <span className="label-eyebrow w-28 text-right">People</span>
        <span className="label-eyebrow w-24 text-right">Finished</span>
        <span className="label-eyebrow w-32 text-right">How far they get</span>
      </div>

      <ul>
        {rows.map((row) => (
          <li
            key={row.bucket}
            className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-hairline px-4 py-3 last:border-0"
          >
            <div className="min-w-0 truncate text-sm text-ink" title={row.bucket}>
              {label(row.bucket)}
            </div>

            <div className="w-28 text-right">
              <div className="text-sm font-medium tabular-nums text-ink">
                {formatPeople(row.sessions)}
              </div>
              <div className="text-[10px] tabular-nums text-ink-faint">
                {total > 0 ? formatPct((row.sessions / total) * 100) : '—'}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full funnel-bar--track">
                <div
                  className="funnel-bar"
                  style={{ height: '100%', width: `${barWidthPct(row.sessions, busiest)}%` }}
                />
              </div>
            </div>

            {/* Of the sessions that recorded anything, not of every row: a
                visitor who opened the page and left never had a chance to
                finish, and counting them here would rank a group by how much
                bot traffic it attracted. */}
            <div
              className="w-24 text-right text-sm tabular-nums text-ink-soft"
              title={`${formatPeople(row.completed)} of ${formatPeople(
                row.with_activity,
              )} who started answering`}
            >
              {row.with_activity === 0 ? '—' : formatPct(row.completion_pct)}
            </div>

            <div
              className="w-32 text-right text-sm tabular-nums text-ink-soft"
              title="The question the typical person in this group reached before stopping."
            >
              {medianQuestion(row.median_max_position)}
              {deepest > 0 && row.median_max_position !== null ? (
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full funnel-bar--track">
                  <div
                    className="funnel-bar"
                    style={{
                      height: '100%',
                      width: `${barWidthPct(row.median_max_position, deepest)}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
