import { BarList } from '@/app/_components/BarList';
import { FilterBar } from '@/app/_components/FilterBar';
import { FunnelChart } from '@/app/_components/FunnelChart';
import { Panel, PanelEmpty } from '@/app/_components/Panel';
import { QueryError } from '@/app/_components/QueryError';
import { RetentionNote } from '@/app/_components/RetentionNote';
import { StatCard } from '@/app/_components/StatCard';
import { Warnings } from '@/app/_components/Warnings';
import {
  filterHref,
  parseFilters,
  rangeLabel,
  requiredQuizVersion,
  wasClamped,
  type DashboardSearchParams,
} from '@/lib/filters';
import { loadFunnelView, type FunnelView } from '@/lib/funnel';
import {
  deviceLabel,
  dropSeverity,
  formatDuration,
  formatPct,
  formatPeople,
  formatWait,
  languageName,
  rankByLoss,
} from '@/lib/presentation';
import {
  liveSessions,
  resolveRange,
  segmentBreakdown,
  sessionTotals,
  type LiveRow,
  type SegmentOptionRow,
  type SegmentRow,
  type SessionTotalsRow,
} from '@/lib/queries';
import { LiveAutoRefresh } from './live/LiveAutoRefresh';

export const dynamic = 'force-dynamic';

const TOP_N = 5;
/** Five rows at --row-h, so a half-empty panel keeps the grid square. */
const PANEL_BODY_MIN = 200;
const LIVE_WINDOW_MINUTES = 15;

/**
 * The one screen to open first.
 *
 * ONE quiz version, like Drop-off: the chart and the ranked losses are
 * position-shaped, so requiredQuizVersion() inside loadFunnelView() applies and
 * no "All versions" chip is offered. The live and segment panels alongside are
 * per-session counts and would blend safely, but a board where half the panels
 * answer a different question from the other half is worse than one that
 * consistently reports a single version.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);

  let view: FunnelView;
  let segmentOptions: SegmentOptionRow[];
  let quizVariant: string;
  let totalsRows: SessionTotalsRow[];
  let live: LiveRow[];
  let locales: SegmentRow[];
  let devices: SegmentRow[];
  try {
    const range = resolveRange(filters);
    // Independent reports, fetched together — the page costs the slowest query
    // rather than the sum of them.
    const [funnel, totalsResult, liveResult, localeResult, deviceResult] = await Promise.all([
      loadFunnelView(filters),
      sessionTotals(range, filters, requiredQuizVersion(filters)),
      liveSessions(LIVE_WINDOW_MINUTES, filters),
      segmentBreakdown(range, 'locale', filters),
      segmentBreakdown(range, 'device', filters),
    ]);
    ({ view, segments: segmentOptions, quizVariant } = funnel);
    totalsRows = totalsResult;
    live = liveResult;
    locales = localeResult;
    devices = deviceResult;
  } catch (error) {
    return <QueryError error={error} />;
  }

  const { totals } = view;
  const activeNow = live.reduce((sum, r) => sum + r.active_sessions, 0);

  // Merged by step, unlike the live tab. cro_live_sessions reports one row per
  // (step, basis), so a step holding both people who saved their way there and
  // people who have only just arrived comes back twice — which on a five-row
  // summary panel renders as the same question listed twice with no
  // explanation of why. The live tab keeps them apart and says which is which.
  const liveByStep = [
    ...live
      .reduce((acc, r) => {
        const found = acc.get(r.step_id);
        if (found) {
          found.active_sessions += r.active_sessions;
          found.p50_dwell_seconds = Math.max(
            found.p50_dwell_seconds ?? 0,
            r.p50_dwell_seconds ?? 0,
          );
        } else acc.set(r.step_id, { ...r });
        return acc;
      }, new Map<string, LiveRow>())
      .values(),
  ].sort((a, b) => b.active_sessions - a.active_sessions);

  // cro_session_totals returns one row per funnel variant, so an app running an
  // A/B gets several. Summing is right for the same reason the assembler merges
  // funnel arms: one question set, several presentations.
  const sessions = sum(totalsRows, (r) => r.sessions);
  const noActivity = sum(totalsRows, (r) => r.no_activity);
  const leadCaptured = sum(totalsRows, (r) => r.lead_captured);

  // Ranked over every SCREEN, not the grouped positions: a cliff on a follow-up
  // screen is a real cliff, and Drop-off folds branches away by default — this
  // panel is where they stay visible. Retired steps are excluded: they are not
  // a question anyone can go and fix.
  const screens = view.steps
    .filter((group) => !group.retired)
    .flatMap((group) => [group.lead, ...group.companions, ...group.branches])
    .filter((step) => step.inCatalog);

  // The floor stays proportional so a 17-person dataset still ranks something
  // rather than showing an empty panel. Same rule the assembler applies to
  // biggestLoss, so the headline and this list cannot disagree about first place.
  const lossFloor = totals.smallSample ? 1 : 20;
  const worstDrops = rankByLoss(
    screens.filter((s) => s.viewed >= lossFloor && s.dropped > 0),
    totals.entered,
  ).slice(0, TOP_N);

  const slowest = screens
    .filter((s) => s.p50Ms !== null && s.answered > 0)
    .slice()
    .sort((a, b) => (b.p50Ms ?? 0) - (a.p50Ms ?? 0))
    .slice(0, TOP_N);

  const localeSlices = locales.slice(0, TOP_N);
  const segmentTotal = sum(locales, (r) => r.sessions);

  return (
    <div className="space-y-4">
      <LiveAutoRefresh intervalMs={30_000} />

      <header>
        <h2 className="text-lg font-semibold text-ink">Overview</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {rangeLabel(filters)} · counted per visit
          {filters.locale ? ` · ${languageName(filters.locale)} only` : ''}
        </p>
      </header>

      <FilterBar filters={filters} basePath="/dashboard" segments={segmentOptions} />
      <RetentionNote clamped={wasClamped(params.from)} filters={filters} />

      <Warnings warnings={view.warnings} />

      {sessions === 0 ? (
        <div className="card px-4 py-12 text-center text-sm text-ink-faint">
          Nobody has taken this version of the quiz in this period yet.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Started"
              value={formatPeople(totals.entered)}
              unit="reached the first question"
            />
            <StatCard
              label="Reached the end"
              value={formatPeople(totals.finished)}
              unit="people"
            />
            <StatCard
              label="Finish rate"
              value={formatPct(totals.finishPct)}
              unit="of those who started"
            />
            <StatCard
              label="In the quiz now"
              value={formatPeople(activeNow)}
              unit={`active in the last ${LIVE_WINDOW_MINUTES} min`}
            />
          </div>

          {/* The gap between "a session row exists" and "somebody answered
              something". Every other number on this board starts from the
              funnel, which skips sessions with no recorded activity — so
              without this line the board silently under-reports its own
              starts and nothing says by how much. */}
          {noActivity > 0 ? (
            <p className="text-xs text-ink-faint">
              {formatPeople(sessions)} visits opened the quiz;{' '}
              {formatPeople(noActivity)} of them left before anything was recorded, so they
              are not in the numbers above.
              {leadCaptured > 0 ? ` ${formatPeople(leadCaptured)} left an email.` : ''}
            </p>
          ) : null}

          {/* The chart is the primary element on this screen: full width, real
              height. Everything below it is supporting detail. */}
          <Panel
            title="How many people are still going"
            hint="Every question in order, from the first to the last."
            href={filterHref('/dashboard/steps', filters)}
          >
            <FunnelChart rows={view.steps} finished={totals.finished} />
          </Panel>

          <div className="grid gap-3 xl:grid-cols-3">
            <Panel
              title="Biggest losses"
              hint={
                totals.smallSample
                  ? 'Ranked by people, not percentage — the sample is small.'
                  : 'Questions where the most people give up.'
              }
              href={filterHref('/dashboard/steps', filters, { detail: '1', arms: '1' })}
              minBody={PANEL_BODY_MIN}
            >
              {worstDrops.length === 0 ? (
                <PanelEmpty>Nobody has dropped out yet.</PanelEmpty>
              ) : (
                <BarList
                  variant="rank"
                  max={0}
                  formatValue={(n) => formatPeople(n)}
                  items={worstDrops.map((s) => ({
                    label: s.label,
                    title: s.stepId,
                    value: s.dropped,
                    note: formatPct(s.dropPct),
                    alert: dropSeverity(s.dropPct) === 'heavy',
                  }))}
                />
              )}
            </Panel>

            <Panel
              title="Right now"
              hint="Where people are at this moment."
              href={filterHref('/dashboard/live', filters)}
              linkLabel="Open live"
              minBody={PANEL_BODY_MIN}
            >
              {liveByStep.length === 0 ? (
                <PanelEmpty>Nobody is taking the quiz right now.</PanelEmpty>
              ) : (
                <BarList
                  max={Math.max(...liveByStep.map((r) => r.active_sessions))}
                  items={liveByStep.slice(0, TOP_N).map((r) => ({
                    label: r.label ?? r.step_id,
                    title: r.step_id,
                    value: r.active_sessions,
                    note: formatWait(r.p50_dwell_seconds),
                  }))}
                />
              )}
            </Panel>

            <Panel
              title="Slowest questions"
              hint="Typical time before answering."
              href={filterHref('/dashboard/steps', filters, { detail: '1', arms: '1' })}
              minBody={PANEL_BODY_MIN}
            >
              {slowest.length === 0 ? (
                <PanelEmpty>No timings recorded yet.</PanelEmpty>
              ) : (
                <BarList
                  variant="rank"
                  max={0}
                  formatValue={(n) => formatDuration(n)}
                  items={slowest.map((s) => ({
                    label: s.label,
                    title: s.stepId,
                    value: s.p50Ms ?? 0,
                  }))}
                />
              )}
            </Panel>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
            <Panel
              title="Languages"
              hint="Which language people take the quiz in."
              href={filterHref('/dashboard/segments', filters)}
            >
              {localeSlices.length === 0 ? (
                <PanelEmpty>No data yet.</PanelEmpty>
              ) : (
                <BarList
                  max={localeSlices[0]!.sessions}
                  items={localeSlices.map((slice) => ({
                    label: languageName(slice.bucket === 'unknown' ? null : slice.bucket),
                    title: slice.bucket,
                    value: slice.sessions,
                    note:
                      segmentTotal > 0
                        ? formatPct((slice.sessions / segmentTotal) * 100)
                        : undefined,
                  }))}
                />
              )}
            </Panel>

            <Panel
              title="Devices"
              hint="What people are using."
              href={filterHref('/dashboard/segments', filters)}
            >
              {devices.length === 0 ? (
                <PanelEmpty>No data yet.</PanelEmpty>
              ) : (
                <BarList
                  max={devices[0]!.sessions}
                  items={devices.map((slice) => ({
                    label: deviceLabel(slice.bucket),
                    title: slice.bucket,
                    value: slice.sessions,
                    note:
                      segmentTotal > 0
                        ? formatPct((slice.sessions / segmentTotal) * 100)
                        : undefined,
                  }))}
                />
              )}
            </Panel>
          </div>

          <p className="text-xs text-ink-faint">
            Reporting on {quizVariant}. The period filters on when a visit started, so a
            visit begun before the window and still running is not counted.
          </p>
        </>
      )}
    </div>
  );
}

function sum<T>(rows: readonly T[], of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0);
}
