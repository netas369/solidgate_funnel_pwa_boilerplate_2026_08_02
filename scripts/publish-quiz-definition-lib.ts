// Pure logic for scripts/publish-quiz-definition.ts — no I/O, no env, no
// network, so it can be unit-tested. Same split as
// solidgate-reconciliation-evidence.ts next to its runner.
//
// Imports use deep relative paths on purpose: repo-root scripts run under
// `npx tsx` with NO tsconfig and NO path aliases, so `@/...` does not resolve.
// config/step-answer-keys.ts is reachable because its only import is
// ./quiz-schema, which imports only zod.

import { createHash } from 'node:crypto';
import { allowedKeysForStep } from '../apps/funnel/src/features/quiz/config/step-answer-keys';
import type { QuizStep } from '../apps/funnel/src/features/quiz/config/quiz-schema';

export interface StepEdge {
  to_step_id: string;
  on_value: string | null;
}

export interface PublishedStepRow {
  step_id: string;
  position: number;
  sort_index: number;
  step_type: string;
  phase_key: string | null;
  store_as: string | null;
  is_question: boolean;
  is_terminal: boolean;
  answer_keys: string[];
  /**
   * Declared answer codes for this step, in config order. Empty for step types
   * that have no options. Lets a dashboard say "no longer an option" instead of
   * rendering a bare code for an answer whose option was later removed.
   */
  option_values: string[];
  /** i18n key the label came from, kept so a dashboard can localise later. */
  label_key: string | null;
  /** Resolved English text. The i18n KEY is useless in a dashboard. */
  label: string | null;
  /**
   * True when EVERY route from the first step to a terminal passes through this
   * step. False means only some visitors are routed here, so its drop must be
   * measured against its own views rather than the position's traffic.
   */
  is_unconditional: boolean;
  /** True when an entry condition can route a visitor PAST this step entirely. */
  entry_skippable: boolean;
  next: StepEdge[];
  /** Other step ids sharing this position — i.e. the other arms of a branch. */
  shares_position_with: string[];
  /** False when no path from the first step reaches this one. */
  reachable: boolean;
}

export interface DefinitionSnapshot {
  quiz_variant: string;
  app_key: string;
  funnel_key: string;
  first_step_id: string;
  total_steps: number;
  config_hash: string;
  steps: PublishedStepRow[];
}

export interface QuizConfigLike {
  steps: QuizStep[];
  stepPositions: Record<string, number>;
  totalSteps: number;
}

/**
 * Recursive canonical form for hashing.
 *
 * Object keys are sorted with a bare `sort()` (UTF-16 code-unit order —
 * deterministic across Node versions and locales, unlike localeCompare), and
 * `undefined` values are dropped so an absent optional field and an explicitly
 * undefined one hash identically. ARRAY ORDER IS PRESERVED: order is semantic
 * in steps, options and fields, and reordering answer options is a real quiz
 * change that must alter the hash.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    result[key] = canonicalize(source[key]);
  }
  return result;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Declared option values for the step types that have them, in config order.
 *
 * These are answer CODES (`o1`, `female`), not copy — the labels beside them in
 * quiz-config.ts are i18n keys. So they belong in the hash: changing a step's
 * option vocabulary changes the meaning of every answer already recorded under
 * that key, whereas renaming the label does not.
 */
function optionValues(step: QuizStep): string[] {
  const candidate = step as unknown as { options?: Array<{ value?: unknown }> };
  if (!Array.isArray(candidate.options)) return [];
  return candidate.options
    .map((option) => option?.value)
    .filter((value): value is string => typeof value === 'string');
}

/**
 * Successor edges for one step.
 *
 * Terminal steps emit NOTHING. quiz-config.ts gives step7 `nextStepId: 'step7'`
 * as an unused placeholder, and the DB's no-self-edge CHECK rejects it on
 * purpose — publishing it would make every terminal step a phantom cycle in the
 * dashboard's reachability graph.
 */
/**
 * Routing constructs this file knows how to turn into edges.
 *
 * The reachability that decides `is_unconditional` is only as good as the edge
 * list, and a MISSED route makes a conditional step look unconditional — which
 * reports a branch as drop-off, silently and plausibly.
 *
 * This was found by running this algorithm over carnivore-app's real 47-step
 * quiz and diffing against its independently generated manifest: three steps
 * disagreed, all because that config uses routing this file does not model —
 * `skipIf` (an entry condition that routes PAST a step) and `branches` /
 * `whenOnly` (a conditional successor). The boilerplate schema has neither, so
 * the result here is correct; the guard exists so that stays true.
 */
// `stepId` is the step's own identifier, not a route out of it.
const KNOWN_ROUTING_KEYS = new Set(["nextStepId", "stepId"]);

/**
 * Refuse to publish a step whose routing this file cannot model.
 *
 * Failing the publish is the whole point: the alternative is a definition that
 * looks fine and quietly misclassifies every branch downstream of the construct.
 */
function assertKnownRouting(step: QuizStep): void {
  const unknown = Object.keys(step).filter(
    (key) =>
      !KNOWN_ROUTING_KEYS.has(key) &&
      (key === "skipIf" || key === "branches" || key === "whenOnly" || /stepid$/i.test(key)),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Step "${step.stepId}" uses routing this publisher does not model: ${unknown.join(", ")}.\n` +
        `Reachability decides is_unconditional, and an unmodelled route makes a branch look\n` +
        `like a step everyone sees — which reports routing as drop-off. Teach stepEdges()\n` +
        `about it (see scripts/quiz-step-graph-build.ts in carnivore-app for skipIf handling)\n` +
        `before publishing.`,
    );
  }
}

export function stepEdges(step: QuizStep, terminalTypes: ReadonlySet<string>): StepEdge[] {
  assertKnownRouting(step);
  if (terminalTypes.has(step.type)) return [];

  const withOptions = step as unknown as {
    options?: Array<{ value?: unknown; nextStepId?: unknown }>;
  };
  if (Array.isArray(withOptions.options)) {
    const branching = withOptions.options.filter(
      (option) => typeof option?.nextStepId === 'string',
    );
    if (branching.length > 0) {
      return branching.map((option) => ({
        to_step_id: option.nextStepId as string,
        on_value: typeof option.value === 'string' ? option.value : null,
      }));
    }
  }

  const stepLevel = (step as unknown as { nextStepId?: unknown }).nextStepId;
  if (typeof stepLevel === 'string' && stepLevel !== step.stepId) {
    return [{ to_step_id: stepLevel, on_value: null }];
  }
  return [];
}

/** Read a dot path such as `steps.step1.question` out of the message pack. */
function lookupMessage(messages: unknown, key: string): string | null {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

/**
 * The i18n key that best names a step in a dashboard.
 *
 * Every string in quiz-config.ts is a KEY, not a sentence — that is what makes
 * the quiz translatable — so the config alone can never supply a readable label.
 * Which field holds the key differs by step type, hence the ordered attempts
 * plus a probe against the message pack for the types that carry no text field
 * in the config at all (email_capture titles its screen from the pack;
 * loading_screen only has a brand line).
 */
export function labelKeyForStep(step: QuizStep, messages: unknown): string | null {
  const candidate = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  const direct =
    candidate((step as unknown as { question?: unknown }).question) ??
    candidate((step as unknown as { title?: unknown }).title);
  if (direct) return direct;

  // checkpoint: the copy lives under the fallback variant.
  const variants = (step as unknown as { variants?: Record<string, { title?: unknown }> }).variants;
  const fallback = (step as unknown as { fallbackVariant?: unknown }).fallbackVariant;
  if (variants && typeof fallback === 'string') {
    const fromVariant = candidate(variants[fallback]?.title);
    if (fromVariant) return fromVariant;
  }
  if (variants) {
    for (const variant of Object.values(variants)) {
      const fromAny = candidate(variant?.title);
      if (fromAny) return fromAny;
    }
  }

  for (const field of ['question', 'title', 'brand'] as const) {
    const probe = `steps.${step.stepId}.${field}`;
    if (lookupMessage(messages, probe) !== null) return probe;
  }
  return candidate((step as unknown as { brand?: unknown }).brand);
}

function storeAsOf(step: QuizStep): string | null {
  const value = (step as unknown as { storeAs?: unknown }).storeAs;
  return typeof value === 'string' ? value : null;
}

/**
 * The hash input for one step: STRUCTURE ONLY.
 *
 * Every string in quiz-config.ts is an i18n key. Deliberately excluded are
 * `question`, `subtitle`, `label`, `title` and friends — copy edits are the
 * single most common CRO change, and if they forced a quiz_variant bump someone
 * would disable this guard within two months. What IS covered is everything
 * that changes the meaning of collected data: identity, ordering, type, the
 * answer key, the option vocabulary and the branch wiring.
 */
function stepHashInput(row: PublishedStepRow) {
  return {
    step_id: row.step_id,
    position: row.position,
    sort_index: row.sort_index,
    step_type: row.step_type,
    store_as: row.store_as,
    is_question: row.is_question,
    is_terminal: row.is_terminal,
    entry_skippable: row.entry_skippable,
    answer_keys: row.answer_keys,
    // The answer VOCABULARY, not its copy. Omitting this let a multi_select's
    // options change without a QUIZ_VARIANT bump while the publisher still
    // reported "unchanged" — so one variant could hold two answer vocabularies
    // and an answer distribution would blend them with no symptom.
    option_values: row.option_values,
    next: row.next,
  };
}

export function stepHash(row: PublishedStepRow): string {
  return sha256(stableStringify(stepHashInput(row)));
}

/**
 * Which steps are reachable from `from`, optionally pretending `excluding` does
 * not exist. Ported from scripts/quiz-step-graph-build.ts in carnivore-app and
 * glp-app, where it has been in production long enough to be trusted.
 */
function reachableSet(
  rows: PublishedStepRow[],
  from: string,
  excluding?: string,
): Set<string> {
  const byId = new Map(rows.map((row) => [row.step_id, row]));
  const seen = new Set<string>();
  const queue: string[] = [from];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === excluding || seen.has(id)) continue;
    seen.add(id);
    for (const edge of byId.get(id)?.next ?? []) {
      if (edge.to_step_id !== excluding && !seen.has(edge.to_step_id)) {
        queue.push(edge.to_step_id);
      }
    }
  }
  return seen;
}

/** Breadth-first reachability from the first step over the published edges. */
function reachableFrom(first: string, rows: PublishedStepRow[]): Set<string> {
  const byId = new Map(rows.map((row) => [row.step_id, row]));
  const seen = new Set<string>();
  const queue: string[] = [first];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of byId.get(id)?.next ?? []) {
      if (!seen.has(edge.to_step_id)) queue.push(edge.to_step_id);
    }
  }
  return seen;
}

export function buildDefinitionSnapshot(
  config: QuizConfigLike,
  options: {
    quizVariant: string;
    appKey: string;
    funnelKey: string;
    firstStepId: string;
    terminalTypes: ReadonlySet<string>;
    /** The en message pack, so labels are stored as sentences not i18n keys. */
    messages?: unknown;
  },
): DefinitionSnapshot {
  const byPosition = new Map<number, string[]>();
  for (const step of config.steps) {
    const position = config.stepPositions[step.stepId] ?? 0;
    byPosition.set(position, [...(byPosition.get(position) ?? []), step.stepId]);
  }

  // sort_index is the array index and is the STABLE key. Never key on position:
  // the shipped config has 8 steps and totalSteps 7 because step3 and step3b
  // share position 3, so anything upserting on position silently loses an arm.
  const rows: PublishedStepRow[] = config.steps.map((step, index) => {
    const answerKeys = allowedKeysForStep(step);
    const position = config.stepPositions[step.stepId] ?? 0;
    const labelKey = labelKeyForStep(step, options.messages);
    return {
      step_id: step.stepId,
      position,
      sort_index: index + 1,
      step_type: String(step.type),
      phase_key: typeof step.phase === 'string' ? step.phase : null,
      store_as: storeAsOf(step),
      // The empty-answer-keys classifier. This is the only reliable
      // question-vs-screen signal: step_completed fires for auto-advancing
      // screens too (use-quiz-navigation's goToStepReplace).
      is_question: answerKeys.length > 0,
      is_terminal: options.terminalTypes.has(step.type),
      answer_keys: answerKeys,
      option_values: optionValues(step),
      next: stepEdges(step, options.terminalTypes),
      label_key: labelKey,
      label: labelKey ? lookupMessage(options.messages, labelKey) : null,
      // Computed below, once every row's edges exist.
      is_unconditional: true,
      // The boilerplate quiz schema has no skipIf concept, so nothing can route
      // a visitor PAST a step. Kept in the contract because products that do
      // have one (carnivore-app) need it for the "never saw this question" note.
      entry_skippable: false,
      shares_position_with: (byPosition.get(position) ?? []).filter(
        (id) => id !== step.stepId,
      ),
      reachable: false,
    };
  });

  const reached = reachableFrom(options.firstStepId, rows);
  for (const row of rows) row.reachable = reached.has(row.step_id);

  // Is a step on EVERY route to the end, or only some?
  //
  // Decided by deleting the step and asking whether any terminal is still
  // reachable — NOT by whether it shares a position with another step. That
  // heuristic is wrong in both directions: two screens everyone walks through
  // can share a position, and a genuine branch arm can sit alone on one. Both
  // products' docs call the position heuristic out as a mistake, and their
  // older admin boards still make it.
  const liveTerminals = rows
    .filter((row) => row.is_terminal && row.reachable)
    .map((row) => row.step_id);
  for (const row of rows) {
    if (row.step_id === options.firstStepId) {
      row.is_unconditional = true;
      continue;
    }
    if (!row.reachable || liveTerminals.length === 0) {
      row.is_unconditional = false;
      continue;
    }
    const without = reachableSet(rows, options.firstStepId, row.step_id);
    row.is_unconditional = liveTerminals.every((id) => !without.has(id));
  }

  const configHash = sha256(
    stableStringify({
      quiz_variant: options.quizVariant,
      first_step_id: options.firstStepId,
      total_steps: config.totalSteps,
      // Composing the header hash out of the per-step hashes means the two can
      // never disagree, and drift attribution stays exact.
      step_hashes: rows.map((row) => [row.step_id, stepHash(row)]),
    }),
  );

  return {
    quiz_variant: options.quizVariant,
    app_key: options.appKey,
    funnel_key: options.funnelKey,
    first_step_id: options.firstStepId,
    total_steps: config.totalSteps,
    config_hash: configHash,
    steps: rows,
  };
}

export interface StepDiff {
  step_id: string;
  change: 'added' | 'removed' | 'changed';
  fields?: string[];
}

/** Field-level diff between a published step set and a freshly built one. */
export function diffStepRows(
  published: PublishedStepRow[],
  computed: PublishedStepRow[],
): StepDiff[] {
  const publishedById = new Map(published.map((row) => [row.step_id, row]));
  const computedById = new Map(computed.map((row) => [row.step_id, row]));
  const diffs: StepDiff[] = [];

  for (const row of computed) {
    const previous = publishedById.get(row.step_id);
    if (!previous) {
      diffs.push({ step_id: row.step_id, change: 'added' });
      continue;
    }
    const fields = (
      ['position', 'sort_index', 'step_type', 'store_as', 'is_question', 'is_terminal'] as const
    ).filter((field) => stableStringify(previous[field]) !== stableStringify(row[field]));
    if (stableStringify(previous.answer_keys) !== stableStringify(row.answer_keys)) {
      fields.push('answer_keys' as never);
    }
    if (stableStringify(previous.option_values) !== stableStringify(row.option_values)) {
      fields.push('option_values' as never);
    }
    if (stableStringify(previous.next) !== stableStringify(row.next)) {
      fields.push('next' as never);
    }
    if (fields.length > 0) {
      diffs.push({ step_id: row.step_id, change: 'changed', fields: [...fields] });
    }
  }

  for (const row of published) {
    if (!computedById.has(row.step_id)) {
      diffs.push({ step_id: row.step_id, change: 'removed' });
    }
  }

  return diffs;
}
