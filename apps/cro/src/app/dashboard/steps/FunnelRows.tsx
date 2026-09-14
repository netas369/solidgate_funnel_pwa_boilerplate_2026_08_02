import type { AssembledPosition, AssembledStep } from '@repo/shared/cro/funnel-response';
import { filterHref, type DashboardFilters } from '@/lib/filters';
import { formatChange, formatDuration, formatPct, formatPeople } from '@/lib/presentation';

/**
 * The drop-off list's rows: one per quiz position, with its follow-up screens
 * nested underneath.
 *
 * Split from the page so the arithmetic-to-pixels half renders on its own
 * against fixture data — the page opens a Supabase client, which a component
 * test has no business doing. Everything here is pure and server-rendered.
 *
 * Almost every number arrives precomputed from assembleFunnelResponse. The
 * references worked out `barWidthPct`, the arm badge floor and the share-of-slot
 * denominator inside their row components, which is exactly where the two forks
 * drifted apart; here the component's only job is to decide what appears.
 */
export function PositionRow({
  group,
  showArms,
  showDetail,
  filters,
}: {
  group: AssembledPosition;
  showArms: boolean;
  showDetail: boolean;
  filters: DashboardFilters;
}) {
  // A retired bucket has no position, no displayIndex and no bar. Neither
  // reference handles it, and without this branch the row renders "—" against
  // a bar computed from a null.
  if (group.retired) return <RetiredRow group={group} />;

  const { lead } = group;

  // Collapsing hides a branch screen's whole drop, so a bad one announces
  // itself from the collapsed row or the default view is a lie by omission.
  const armAlert = showArms ? null : group.armAlertPct;

  return (
    <li className="border-b border-hairline px-4 py-3 last:border-0">
      <div className="flex items-center gap-4">
        <span className="w-6 shrink-0 text-right text-xs tabular-nums text-ink-soft">
          {group.displayIndex}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            {/* The step id lives in the tooltip: an engineer occasionally needs
                it, nobody else should have to read past it. */}
            <span className="truncate text-sm text-ink" title={lead.stepId}>
              {lead.label}
            </span>
            {lead.severityLabel && lead.showBadge ? (
              <Badge severity={lead.severity}>{lead.severityLabel}</Badge>
            ) : null}
            {/* BRANCHES only. Companions are on screen either way, so
                advertising them as hidden follow-ups would be a lie. */}
            {group.branches.length > 0 ? (
              <span className="shrink-0 text-[10px] text-ink-faint">
                +{group.branches.length} branch
              </span>
            ) : null}
          </div>

          {/* The slot's traffic against the funnel's entry count, with the share
              that stopped here painted into its right-hand end. Over thirty rows
              this is what makes a cliff findable without reading a number. */}
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full funnel-bar--track">
            <div
              className="funnel-bar__fill"
              style={{ width: `${group.barPct * (1 - group.dropBarPct / 100)}%` }}
            />
            <div
              className="funnel-bar__drop"
              style={{ width: `${(group.barPct * group.dropBarPct) / 100}%` }}
            />
          </div>
        </div>

        <div className="w-36 shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums text-ink">
            {formatPeople(group.reached)}{' '}
            <span className="text-xs font-normal text-ink-faint">reached</span>
          </div>
          <div
            className="text-xs tabular-nums"
            style={{
              color: lead.severity === 'normal' ? 'var(--ink-soft)' : 'var(--danger)',
              fontWeight: lead.severity === 'heavy' ? 600 : 400,
            }}
          >
            {formatPeople(lead.dropped)} left here ({formatPct(lead.dropPct)})
          </div>
          {formatChange(group.changeFromPrev) ? (
            <div className="text-[10px] tabular-nums text-ink-faint">
              {formatChange(group.changeFromPrev)} since previous
            </div>
          ) : null}
        </div>
      </div>

      {/* The one place `skipped` belongs on a question's own row: these people
          were routed past the slot before it rendered, so they are not part of
          its drop. */}
      {lead.showSkippedNote ? (
        <p className="mt-2 pl-10 text-xs text-ink-faint">
          {formatPeople(lead.skipped)} never saw this question — an earlier answer had
          already settled it.
        </p>
      ) : null}

      {/* Not drop-off: these people were still mid-quiz when the report ran.
          Shown beside the drop, never added to it — see the page footnote. */}
      {lead.unsettled > 0 ? (
        <p className="mt-2 pl-10 text-xs text-ink-faint">
          {formatPeople(lead.unsettled)} were still on this question when the report ran.
        </p>
      ) : null}

      {armAlert !== null ? (
        <p className="mt-2 pl-10 text-xs">
          <span style={{ color: 'var(--danger)' }}>
            A branch screen here loses {formatPct(armAlert)}
          </span>{' '}
          —{' '}
          <a
            href={filterHref('/dashboard/steps', filters, {
              arms: '1',
              ...(showDetail ? { detail: '1' } : {}),
            })}
            className="text-ink-soft underline underline-offset-4"
          >
            show branch screens
          </a>
        </p>
      ) : null}

      {showDetail ? <DetailGrid row={lead} /> : null}

      {/* Companions first and ALWAYS — everyone walks through them, so their
          drop-off belongs in the default view next to the question's own.
          Branches follow, and only when asked for. */}
      {group.companions.length > 0 || (showArms && group.branches.length > 0) ? (
        <ul className="mt-3 space-y-3 pl-10">
          {[...group.companions, ...(showArms ? group.branches : [])].map((arm) => (
            <ArmRow key={arm.stepId} arm={arm} showDetail={showDetail} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Steps with recorded traffic that the published catalog does not contain.
 *
 * They have no slot in the funnel, so a bar, a position or a change against the
 * previous question would all be meaningless. What matters is that they are on
 * screen at all: silently dropping them would hide traffic, and inventing a
 * position for them would put a phantom question in the middle of the chart.
 */
function RetiredRow({ group }: { group: AssembledPosition }) {
  return (
    <li className="border-b border-hairline px-4 py-3 last:border-0">
      <div className="flex items-center gap-4">
        <span className="w-6 shrink-0 text-right text-xs tabular-nums text-ink-soft">—</span>
        <span className="text-sm text-ink-soft">No longer in the quiz</span>
      </div>
      <ul className="mt-2 space-y-2 pl-10">
        {[group.lead, ...group.branches].map((row) => (
          <li key={row.stepId} className="text-xs text-ink-faint">
            <span className="text-ink-soft">{row.label}</span> · {formatPeople(row.viewed)} saw
            it · {formatPeople(row.dropped)} left ({formatPct(row.dropPct)})
          </li>
        ))}
      </ul>
    </li>
  );
}

function ArmRow({ arm, showDetail }: { arm: AssembledStep; showDetail: boolean }) {
  // A companion is part of the spine, so it reads at full strength; a branch is
  // a detour some visitors take, so it sits back. The tag says which, because
  // colour alone is not readable to everyone.
  const isCompanion = arm.inCatalog && arm.isUnconditional;

  return (
    <li className="border-l-2 border-hairline pl-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span
            className={`text-xs ${isCompanion ? 'text-ink' : 'text-ink-soft'}`}
            title={arm.stepId}
          >
            {arm.label}
          </span>
          <span
            className="shrink-0 rounded-full px-2 py-1 text-[10px]"
            style={{ background: 'var(--paper-soft)', color: 'var(--ink-soft)' }}
          >
            {arm.tag}
          </span>
          {/* showBadge carries the traffic floor: without it a screen eight
              people saw announces "most people leave here". */}
          {arm.severityLabel && arm.showBadge ? (
            <Badge severity={arm.severity}>{arm.severityLabel}</Badge>
          ) : null}
        </div>
        <div className="text-right">
          <div
            className="text-xs tabular-nums"
            style={{ color: arm.severity === 'normal' ? 'var(--ink-soft)' : 'var(--danger)' }}
          >
            {formatPeople(arm.dropped)} left here ({formatPct(arm.dropPct)})
          </div>
          {/* Share of the SLOT, never of the funnel's entry count: a screen
              shown to a third of visitors would otherwise read as a 67%
              cliff. */}
          <div className="text-[10px] tabular-nums text-ink-faint">
            seen by {formatPeople(arm.viewed)}
            {arm.shareOfSlotPct === null
              ? null
              : ` · ${formatPct(arm.shareOfSlotPct)} of this question`}
          </div>
        </div>
      </div>
      {showDetail ? <DetailGrid row={arm} /> : null}
    </li>
  );
}

/**
 * The second question, once you know where people leave: how long the question
 * took, and how it resolved.
 *
 * Neither "changed their answer" nor "went back" appears, unlike the references:
 * both need a row per event, and this schema summarises per question instead.
 * quiz_answers holds the FINAL answer, so "changed their mind" is not derivable
 * here — see docs/quiz-backend/CRO_TRACKING.md.
 */
function DetailGrid({ row }: { row: AssembledStep }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
      <Detail term="Typical time" value={formatDuration(row.p50Ms)} />
      <Detail term="Slower visitors took" value={formatDuration(row.p90Ms)} />
      <Detail term="Answered it" value={formatPct(row.completionPct)} />
      <Detail
        term="Still going"
        value={formatPeople(row.unsettled)}
        hint="Mid-quiz when the report ran — not counted as having left."
      />
    </dl>
  );
}

function Badge({
  severity,
  children,
}: {
  severity: AssembledStep['severity'];
  children: React.ReactNode;
}) {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-1 text-[10px] font-medium"
      style={
        severity === 'heavy'
          ? {
              background: 'color-mix(in srgb, var(--danger) 12%, transparent)',
              color: 'var(--danger)',
            }
          : { background: 'var(--paper-soft)', color: 'var(--ink-soft)' }
      }
    >
      {children}
    </span>
  );
}

function Detail({ term, value, hint }: { term: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-ink-soft">{term}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
