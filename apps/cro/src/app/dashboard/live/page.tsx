import { FilterBar } from '@/app/_components/FilterBar';
import { QueryError } from '@/app/_components/QueryError';
import { parseFilters, type DashboardSearchParams } from '@/lib/filters';
import { barWidthPct, formatPeople, formatWait } from '@/lib/presentation';
import {
  funnelSegments,
  liveSessions,
  resolveRange,
  type LiveRow,
  type SegmentOptionRow,
} from '@/lib/queries';
import { LiveAutoRefresh } from './LiveAutoRefresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Sitting on one question this long is worth a look. */
const STUCK_SECONDS = 120;
const WINDOW_MINUTES = 15;

/**
 * Who is in the quiz at this moment, and where.
 *
 * BLENDING VERSIONS IS SAFE HERE, so this tab passes allowBlend — it counts
 * sessions per step, never a per-position curve. On a switchover day the
 * blended view is the one you actually want: traffic is arriving under both
 * versions at once.
 */
export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const filters = parseFilters(await searchParams);

  let rows: LiveRow[];
  let segmentOptions: SegmentOptionRow[];
  try {
    [rows, segmentOptions] = await Promise.all([
      liveSessions(WINDOW_MINUTES, filters),
      funnelSegments(resolveRange(filters)),
    ]);
  } catch (error) {
    return <QueryError error={error} />;
  }

  const total = rows.reduce((sum, r) => sum + r.active_sessions, 0);
  const busiest = rows.reduce((max, r) => Math.max(max, r.active_sessions), 0);
  // The cohort both reference boards lose entirely: a session that never saved
  // has no current_step_id, so keying on that column drops the landing bucket —
  // the biggest one, with the worst drop.
  const landing = rows
    .filter((r) => r.step_basis === 'landing')
    .reduce((sum, r) => sum + r.active_sessions, 0);

  return (
    <div className="space-y-8">
      <LiveAutoRefresh />

      <header>
        <h2 className="flex items-center gap-3 text-xl font-semibold text-ink">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: 'var(--success)' }}
            aria-hidden
          />
          {total === 0
            ? 'Nobody is taking the quiz right now'
            : `${formatPeople(total)} ${total === 1 ? 'person is' : 'people are'} taking the quiz right now`}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Anyone active in the last {WINDOW_MINUTES} minutes, grouped by the question they
          are on. Updates every 10 seconds.
        </p>
      </header>

      <FilterBar
        filters={filters}
        basePath="/dashboard/live"
        segments={segmentOptions}
        allowBlend
      />

      {rows.length === 0 ? (
        <p className="card p-8 text-sm text-ink-soft">
          The board will fill in as people start the quiz.
        </p>
      ) : (
        <section className="card overflow-hidden">
          <ul>
            {rows.map((row) => {
              const stuck = (row.p50_dwell_seconds ?? 0) >= STUCK_SECONDS;
              return (
                <li
                  key={row.step_id}
                  className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-0"
                >
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums text-ink-soft">
                    {row.step_position ?? '—'}
                  </span>

                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink" title={row.step_id}>
                      {row.label ?? row.step_id}
                    </span>
                    {/* Only the weakest basis earns a note. "They have opened
                        the page" and "they are sitting on question 9" are
                        different claims and the row looks identical. */}
                    {row.step_basis === 'landing' ? (
                      <span className="text-[10px] text-ink-faint">
                        just arrived — nothing saved yet, so this is where they start
                      </span>
                    ) : null}
                    <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full funnel-bar--track">
                      <div
                        className="funnel-bar"
                        style={{ width: `${barWidthPct(row.active_sessions, busiest)}%` }}
                      />
                    </div>
                  </div>

                  <div className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-ink">
                    {formatPeople(row.active_sessions)}
                  </div>

                  <div
                    className="w-32 shrink-0 text-right text-xs tabular-nums"
                    style={{ color: stuck ? 'var(--danger)' : 'var(--ink-soft)' }}
                    title="How long this group has been on this question, typically."
                  >
                    {stuck ? 'stuck ' : 'here '}
                    {formatWait(row.p50_dwell_seconds)}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="text-xs text-ink-soft">
        Counts only — no names, emails or answers. A long time on one question is the signal
        worth chasing: it means people are stuck rather than moving through.
        {landing > 0
          ? ` ${formatPeople(landing)} have opened the quiz without saving anything yet, so they are shown on the first question.`
          : ''}{' '}
        Going back does not save, so someone who returned to an earlier question still shows
        on the last one they moved forward into.
      </p>
    </div>
  );
}
