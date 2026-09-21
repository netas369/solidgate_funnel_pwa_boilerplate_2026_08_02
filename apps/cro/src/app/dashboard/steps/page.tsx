import { QueryError } from '@/app/_components/QueryError';
import { FilterBar } from '@/app/_components/FilterBar';
import { FunnelChart } from '@/app/_components/FunnelChart';
import { RetentionNote } from '@/app/_components/RetentionNote';
import { StatCard } from '@/app/_components/StatCard';
import { Warnings } from '@/app/_components/Warnings';
import { loadFunnelView, type FunnelView } from '@/lib/funnel';
import { parseFilters, rangeLabel, wasClamped, type DashboardSearchParams } from '@/lib/filters';
import { formatPct, formatPeople } from '@/lib/presentation';
import type { SegmentOptionRow } from '@/lib/queries';
import { PositionRow } from './FunnelRows';
import { ViewToggles } from './ViewToggles';

export const dynamic = 'force-dynamic';

/**
 * Where people drop off — the board's reason to exist.
 *
 * NO "All versions" CHIP HERE. assembleFunnelResponse merges rows by step_id
 * alone, so two quiz versions where one moved a question produce a plausible
 * chart with the wrong position and the wrong label. requiredQuizVersion()
 * inside loadFunnelView() makes that unreachable rather than merely discouraged.
 */
export default async function StepsPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const showDetail = params.detail === '1';
  const showArms = params.arms === '1';

  let view: FunnelView;
  let segments: SegmentOptionRow[];
  try {
    ({ view, segments } = await loadFunnelView(filters));
  } catch (error) {
    return <QueryError error={error} />;
  }

  const { totals, biggestLoss } = view;
  // Before the publisher has run there is no step order, so there is no funnel:
  // every step lands in the unplaced bucket, `entered` comes from the first
  // PLACED position and is therefore 0, and the three cards confidently report
  // that nobody took a quiz 52 people took. Counts without an order is all this
  // state honestly has, so it is all it shows.
  const catalogPublished = view.quiz.configHash !== null;

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-xl font-semibold text-ink">Where people drop off</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Every question in the quiz, in order, and how many people stopped on each one.
        </p>
      </header>

      <FilterBar filters={filters} basePath="/dashboard/steps" segments={segments} />
      <RetentionNote clamped={wasClamped(params.from)} filters={filters} />

      <Warnings warnings={view.warnings} />

      {view.steps.length === 0 ? (
        <p className="card p-8 text-sm text-ink-soft">
          Nobody has taken this version of the quiz in this period yet.
        </p>
      ) : !catalogPublished ? (
        <section className="card overflow-hidden">
          <div className="border-b border-hairline px-4 py-4">
            <h3 className="text-sm font-medium text-ink">
              What was recorded · {rangeLabel(filters)}
            </h3>
            <p className="mt-1 text-xs text-ink-faint">
              Every step that saw traffic, by its id. Publish the definition and this
              becomes the funnel — in order, named, with the branches resolved.
            </p>
          </div>
          <ol>
            {view.steps.map((group) => (
              <PositionRow
                key={group.position ?? `unplaced:${group.lead.stepId}`}
                group={group}
                showArms={showArms}
                showDetail={showDetail}
                filters={filters}
                catalogPublished={false}
              />
            ))}
          </ol>
        </section>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Started the quiz"
              value={formatPeople(totals.entered)}
              unit="people"
            />
            <StatCard
              label="Reached the end"
              value={formatPeople(totals.finished)}
              unit="people"
            />
            <StatCard
              label="Finished"
              value={formatPct(totals.finishPct)}
              unit="of everyone who started"
            />
          </div>

          {biggestLoss ? (
            <div className="card border-l-4 p-4" style={{ borderLeftColor: 'var(--danger)' }}>
              <p className="label-eyebrow" style={{ color: 'var(--danger)' }}>
                Biggest loss
              </p>
              <p className="mt-2 text-base font-medium text-ink">
                &ldquo;{biggestLoss.label}&rdquo;
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                {formatPeople(biggestLoss.droppedPeople)} people saw this
                {biggestLoss.isLeadOfPosition
                  ? ''
                  : ` extra screen at question ${biggestLoss.displayIndex}`}{' '}
                and left without answering — {formatPct(biggestLoss.dropPct)} of everyone who
                saw it.
              </p>
            </div>
          ) : null}

          <section className="card overflow-hidden">
            <div className="border-b border-hairline px-4 py-4">
              <h3 className="text-sm font-medium text-ink">
                How many are still going · {rangeLabel(filters)}
              </h3>
            </div>
            <FunnelChart rows={view.steps} finished={totals.finished} />
          </section>

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-4">
              <h3 className="text-sm font-medium text-ink">The quiz, question by question</h3>
              <ViewToggles
                showArms={showArms}
                showDetail={showDetail}
                armCount={view.armCount}
                filters={filters}
              />
            </div>

            <ol>
              {view.steps.map((group) => (
                <PositionRow
                  // Retired steps all share a null position, and there is only
                  // ever one such bucket — but keying on the lead's step id
                  // holds whether that stays true.
                  key={group.position ?? `retired:${group.lead.stepId}`}
                  group={group}
                  showArms={showArms}
                  showDetail={showDetail}
                  filters={filters}
                />
              ))}
            </ol>
          </section>

          <p className="text-xs text-ink-soft">
            Counted per visit — someone who takes the quiz twice counts twice. &ldquo;Left
            here&rdquo; means they saw the question and never answered it, and it excludes
            anyone still mid-quiz when the report ran: those are counted separately and never
            added in. The period filters on when a visit STARTED, so a visit begun before the
            window and still running is not in these numbers. Extra screens are grouped under
            the question they belong to — the ones everyone walks through are always listed,
            and the branches only some visitors are routed to are folded away until you ask.
          </p>
        </>
      )}
    </div>
  );
}
