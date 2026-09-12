/**
 * Assembles cro_step_funnel rows into the display-ready CRO dashboard payload.
 *
 * READ docs/quiz-backend/CRO_TRACKING.md BEFORE CHANGING ANYTHING HERE.
 *
 * Call this from the app's own CRO dashboard rather than querying step_activity
 * directly. Between this file and cro_step_funnel() live four things a fresh
 * query gets wrong WITHOUT ANNOUNCING IT: whether a session advanced past a
 * step (needs the edge graph), the settle window that stops a mid-quiz cohort
 * reading as drop-off, merging a step that appears once per funnel variant, and
 * the branch-vs-companion split. Each of those produces a plausible chart that
 * is simply wrong.
 *
 * Semantics are ported from apps/cro/src/lib/funnel-view.ts and
 * presentation.ts in carnivore-app and glp-app so a dashboard built against
 * those keeps reading the same numbers.
 */

/** Exactly the row shape public.cro_step_funnel returns. */
export interface CroStepFunnelRow {
  quiz_variant: string;
  funnel_variant: string;
  step_id: string;
  step_position: number | null;
  sort_index: number | null;
  step_type: string | null;
  phase_key: string | null;
  label: string | null;
  is_question: boolean;
  is_terminal: boolean;
  is_unconditional: boolean;
  entry_skippable: boolean;
  in_catalog: boolean;
  has_traffic: boolean;
  position_cohort: number;
  viewed: number;
  answered: number;
  skipped: number;
  advanced: number;
  dropped: number;
  unsettled: number;
  total_views: number;
  revisits: number;
  p50_seconds_to_answer: number | null;
  p90_seconds_to_answer: number | null;
}

export interface SegmentOption {
  id: string;
  /** Human name for the picker button. Falls back to `id` when unregistered. */
  label: string;
  /** Versions only: what changed. "v2 vs v3" means nothing on its own. */
  note?: string;
  sessions: number;
  firstSeen?: string | null;
  lastSeen?: string | null;
}

export type DropSeverity = "heavy" | "notable" | "normal";

export interface AssembledStep {
  stepId: string;
  label: string;
  kind: "question" | "screen";
  viewed: number;
  answered: number;
  skipped: number;
  dropped: number;
  dropPct: number;
  completionPct: number;
  unsettled: number;
  inCatalog: boolean;
  isUnconditional: boolean;
  entrySkippable: boolean;
  /** True when an entry condition routed people past it AND some were. */
  showSkippedNote: boolean;
  p50Ms: number | null;
  p90Ms: number | null;
  /** Null on a lead; set on companions and branches. */
  tag: string | null;
  /** Share of the POSITION's traffic, never of funnel entry. Null on a lead. */
  shareOfSlotPct: number | null;
  severity: DropSeverity;
  severityLabel: string | null;
  /** False below the traffic floor: an arm 8 people saw must not shout. */
  showBadge: boolean;
}

export interface AssembledPosition {
  position: number | null;
  displayIndex: number | null;
  positionPct: number | null;
  retired: boolean;
  hasTraffic: boolean;
  reached: number;
  changeFromPrev: number;
  barPct: number;
  dropBarPct: number;
  severity: DropSeverity;
  severityLabel: string | null;
  lead: AssembledStep;
  companions: AssembledStep[];
  branches: AssembledStep[];
  worstArmDropPct: number;
  /** Non-null only when a collapsed branch is heavy — drives the alert line. */
  armAlertPct: number | null;
}

// ── Thresholds. Ported verbatim; a dashboard built against the forks must not
// see different badges from this app. ──────────────────────────────────────
const HEAVY_DROP_PCT = 25;
const NOTABLE_DROP_PCT = 10;
const SMALL_SAMPLE_PEOPLE = 30;
/** Below this an arm's percentage is noise, so it earns no badge. */
const ARM_BADGE_FLOOR = 30;
/** Below this an arm's drop is too thin to raise the collapsed-row alert. */
const ARM_ALERT_FLOOR = 20;
/** Steps in the data but not in the published catalog bucket here. */
const RETIRED_POSITION = Number.MAX_SAFE_INTEGER;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function dropSeverity(pct: number): DropSeverity {
  if (pct >= HEAVY_DROP_PCT) return "heavy";
  if (pct >= NOTABLE_DROP_PCT) return "notable";
  return "normal";
}

/** Worded badge. Never colour alone — colour is not readable to everyone. */
export function severityLabel(severity: DropSeverity): string | null {
  if (severity === "heavy") return "Most people leave here";
  if (severity === "notable") return "Noticeable drop";
  return null;
}

export function isSmallSample(entered: number): boolean {
  return entered < SMALL_SAMPLE_PEOPLE;
}

function buildStep(
  row: CroStepFunnelRow,
  options: { tag: string | null; shareOfSlotPct: number | null; smallSample: boolean },
): AssembledStep {
  const viewed = row.viewed;
  // Guard viewed > 0 so a step that was only ever skipped reports 0%, not 100%.
  const dropped = viewed > 0 ? Math.max(0, row.dropped) : 0;
  const dropPct = viewed > 0 ? round1((dropped / viewed) * 100) : 0;
  const severity = dropSeverity(dropPct);
  return {
    stepId: row.step_id,
    // Falling back to the id keeps the row readable when a step predates the
    // catalog, rather than rendering an empty cell.
    label: row.label ?? row.step_id,
    kind: row.is_question ? "question" : "screen",
    viewed,
    answered: row.answered,
    skipped: row.skipped,
    dropped,
    dropPct,
    completionPct: viewed > 0 ? round1((row.answered / viewed) * 100) : 0,
    unsettled: row.unsettled,
    inCatalog: row.in_catalog,
    isUnconditional: row.is_unconditional,
    entrySkippable: row.entry_skippable,
    showSkippedNote: row.entry_skippable && row.skipped > 0,
    p50Ms: row.p50_seconds_to_answer === null ? null : Math.round(row.p50_seconds_to_answer * 1000),
    p90Ms: row.p90_seconds_to_answer === null ? null : Math.round(row.p90_seconds_to_answer * 1000),
    tag: options.tag,
    shareOfSlotPct: options.shareOfSlotPct,
    severity,
    severityLabel: severityLabel(severity),
    showBadge: viewed >= ARM_BADGE_FLOOR && !options.smallSample,
  };
}

function armTag(row: CroStepFunnelRow): string {
  if (!row.in_catalog) return "No longer in the quiz";
  return row.is_unconditional ? "Everyone sees this" : "Only some visitors";
}

export interface AssembleOptions {
  appKey: string;
  appLabel: string;
  capabilities: string[];
  quizVariant: string;
  configHash: string | null;
  firstStepId: string | null;
  totalSteps: number | null;
  terminalStepIds: string[];
  range: { from: string; to: string };
  segments: {
    funnels: SegmentOption[];
    versions: SegmentOption[];
    locales: SegmentOption[];
    selected: { funnel: string | null; version: string | null; locale: string | null };
  };
  generatedAt: string;
}

export function assembleFunnelResponse(
  rows: CroStepFunnelRow[],
  options: AssembleOptions,
) {
  // ── 0. Merge rows describing the SAME step.
  //
  // cro_step_funnel groups by (quiz_variant, funnel_variant, step_id), so an app
  // running an A/B through FUNNEL_VARIANT_WEIGHTS returns step1 twice — once per
  // funnel variant. Bucketing those straight by position would file the second
  // copy as an extra SCREEN at that position, and step1 would appear as its own
  // companion with wrong numbers.
  //
  // Summing is correct HERE because a funnel variant is a presentation/offer
  // bucket that shares one quiz_variant: same questions, same positions. It
  // would NOT be correct across quiz variants, which is why `version` always
  // resolves to a single value and is never blended. glp-app's funnel-view.ts
  // merges by step_id the same way.
  const mergedRows = new Map<string, CroStepFunnelRow>();
  for (const row of rows) {
    const found = mergedRows.get(row.step_id);
    if (!found) {
      mergedRows.set(row.step_id, { ...row });
      continue;
    }
    // Percentiles cannot be averaged, so keep the ones from the busier side
    // rather than inventing a number.
    const keepTiming = row.viewed > found.viewed;
    found.viewed += row.viewed;
    found.answered += row.answered;
    found.skipped += row.skipped;
    found.advanced += row.advanced;
    found.dropped += row.dropped;
    found.unsettled += row.unsettled;
    found.total_views += row.total_views;
    found.revisits += row.revisits;
    found.position_cohort += row.position_cohort;
    found.has_traffic = found.has_traffic || row.has_traffic;
    if (keepTiming) {
      found.p50_seconds_to_answer = row.p50_seconds_to_answer;
      found.p90_seconds_to_answer = row.p90_seconds_to_answer;
    }
  }

  // ── 1. Bucket by position. Steps the catalog does not know go to a retired
  // bucket rather than inventing a position for them. ──────────────────────
  const byPosition = new Map<number, CroStepFunnelRow[]>();
  for (const row of mergedRows.values()) {
    const key = row.in_catalog && row.step_position !== null ? row.step_position : RETIRED_POSITION;
    byPosition.set(key, [...(byPosition.get(key) ?? []), row]);
  }

  const ordered = [...byPosition.entries()].sort((a, b) => a[0] - b[0]);

  // ── 2. First pass: reached per position, which every percentage needs. ───
  interface Draft {
    position: number;
    retired: boolean;
    sorted: CroStepFunnelRow[];
    reached: number;
  }
  const drafts: Draft[] = ordered.map(([position, group]) => {
    const retired = position === RETIRED_POSITION;
    // Declaration order, NOT alphabetical: step ids happening to sort correctly
    // is an accident of naming that the next arm called step12a would break.
    const sorted = group
      .slice()
      .sort((a, b) => (a.sort_index ?? 0) - (b.sort_index ?? 0) || a.step_id.localeCompare(b.step_id));
    const lead = sorted[0];
    // Deliberately NOT the sum across the group (double-counts companions) and
    // NOT the max (would mask a data problem). An upper bound, not an identity:
    // someone who went back and came forward again can appear twice.
    const reached = retired ? 0 : lead.viewed + (lead.entry_skippable ? lead.skipped : 0);
    return { position, retired, sorted, reached };
  });

  const live = drafts.filter((d) => !d.retired);
  const entered = live[0]?.reached ?? 0;
  const smallSample = isSmallSample(entered);

  // A terminal screen never gets answered — it advances on its own — so
  // "reached the end" counts VIEWS of the terminal step, not answers.
  const terminalDraft = live
    .filter((d) => d.sorted.some((r) => r.is_terminal))
    .at(-1);
  const finished = terminalDraft?.sorted.find((r) => r.is_terminal)?.viewed ?? 0;

  // ── 3. Second pass: assemble. ────────────────────────────────────────────
  let displayIndex = 0;
  let previousReached: number | null = null;

  const steps: AssembledPosition[] = drafts.map((draft) => {
    const [leadRow, ...rest] = draft.sorted;
    const reached = draft.reached;

    const lead = buildStep(leadRow, { tag: null, shareOfSlotPct: null, smallSample });

    const share = (row: CroStepFunnelRow) =>
      reached > 0 ? round1((row.viewed / reached) * 100) : 0;

    // Everyone walks through a companion, so its drop is real and it is always
    // rendered. A branch was shown to only some visitors, so its drop belongs
    // to its own views and it is folded away until asked for.
    const companions = draft.retired
      ? []
      : rest
          .filter((r) => r.is_unconditional)
          .map((r) => buildStep(r, { tag: armTag(r), shareOfSlotPct: share(r), smallSample }));
    const branches = (draft.retired ? rest : rest.filter((r) => !r.is_unconditional)).map((r) =>
      buildStep(r, { tag: armTag(r), shareOfSlotPct: share(r), smallSample }),
    );

    const worstArmDropPct = branches
      .filter((a) => a.viewed >= ARM_ALERT_FLOOR)
      .reduce((worst, a) => Math.max(worst, a.dropPct), 0);

    if (!draft.retired) displayIndex += 1;
    const changeFromPrev = draft.retired || previousReached === null ? 0 : reached - previousReached;
    if (!draft.retired) previousReached = reached;

    const severity = draft.retired ? "normal" : lead.severity;

    return {
      position: draft.retired ? null : draft.position,
      displayIndex: draft.retired ? null : displayIndex,
      positionPct:
        draft.retired || !options.totalSteps
          ? null
          : round1((draft.position / options.totalSteps) * 100),
      retired: draft.retired,
      hasTraffic: draft.sorted.some((r) => r.has_traffic),
      reached,
      changeFromPrev,
      barPct: entered > 0 ? round1((reached / entered) * 100) : 0,
      dropBarPct: reached > 0 ? round1((lead.dropped / reached) * 100) : 0,
      severity,
      severityLabel: draft.retired ? null : lead.severityLabel,
      lead,
      companions,
      branches,
      worstArmDropPct,
      // Collapsing hides a branch's drop, so a bad one has to announce itself
      // or the default view is a lie by omission.
      armAlertPct: dropSeverity(worstArmDropPct) === "heavy" ? worstArmDropPct : null,
    };
  });

  // ── 4. Biggest loss. Ranked by percentage once there is enough traffic to
  // trust one, by absolute people lost while there is not. ─────────────────
  const lossFloor = smallSample ? 1 : ARM_ALERT_FLOOR;
  const candidates = steps
    .filter((group) => !group.retired)
    .flatMap((group) =>
      [group.lead, ...group.companions, ...group.branches].map((row) => ({ row, group })),
    )
    .filter(({ row }) => row.inCatalog && row.viewed >= lossFloor && row.dropped > 0);

  candidates.sort((a, b) =>
    smallSample
      ? b.row.dropped - a.row.dropped || b.row.dropPct - a.row.dropPct
      : b.row.dropPct - a.row.dropPct || b.row.dropped - a.row.dropped,
  );

  const worst = candidates[0];
  const biggestLoss =
    worst && dropSeverity(worst.row.dropPct) !== "normal"
      ? {
          stepId: worst.row.stepId,
          label: worst.row.label,
          droppedPeople: worst.row.dropped,
          dropPct: worst.row.dropPct,
          isLeadOfPosition: worst.row.stepId === worst.group.lead.stepId,
          displayIndex: worst.group.displayIndex,
        }
      : null;

  const warnings: { code: string; message: string }[] = [];
  if (smallSample && entered > 0) {
    warnings.push({
      code: "SMALL_SAMPLE",
      message: `Only ${entered} people entered — percentages are not meaningful yet.`,
    });
  }
  if (options.configHash === null) {
    warnings.push({
      code: "CATALOG_NOT_PUBLISHED",
      message:
        "This quiz version has no published definition. Step labels and branch handling are unavailable until the publisher runs.",
    });
  }
  if (steps.some((group) => group.retired)) {
    warnings.push({
      code: "RETIRED_STEPS",
      message: "Some recorded steps are no longer in the published quiz.",
    });
  }

  return {
    contract: 1 as const,
    app: {
      key: options.appKey,
      label: options.appLabel,
      generatedAt: options.generatedAt,
      capabilities: options.capabilities,
    },
    segments: options.segments,
    range: options.range,
    quiz: {
      quizVariant: options.quizVariant,
      configHash: options.configHash,
      firstStepId: options.firstStepId,
      totalSteps: options.totalSteps,
      terminalStepIds: options.terminalStepIds,
    },
    totals: {
      entered,
      finished,
      finishPct: entered > 0 ? round1((finished / entered) * 100) : 0,
      smallSample,
    },
    biggestLoss,
    armCount: steps.reduce((sum, group) => sum + group.branches.length, 0),
    steps,
    warnings,
  };
}
