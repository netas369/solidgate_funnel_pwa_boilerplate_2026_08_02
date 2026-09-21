import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CroStepFunnelRow } from '@repo/shared/cro/funnel-response';
import type { CatalogRow, SegmentOptionRow } from './queries';

/**
 * loadFunnelView stitches two RPCs into the assembler's envelope, and the
 * pieces it can drop all fail QUIETLY.
 *
 * `configHash` is the sharp one: it is the only thing that makes the
 * CATALOG_NOT_PUBLISHED warning fire, so a version of this module that forgets
 * it produces a board showing raw step ids beside confident percentages with
 * nothing on screen to explain why. Nothing else in the app would notice.
 */
const stepFunnel = vi.fn<(args: unknown[]) => Promise<CroStepFunnelRow[]>>();
const quizCatalog = vi.fn<(args: unknown[]) => Promise<CatalogRow[]>>();
const funnelSegments = vi.fn<(args: unknown[]) => Promise<SegmentOptionRow[]>>();

vi.mock('./queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./queries')>();
  return {
    ...actual,
    stepFunnel: (...a: unknown[]) => stepFunnel(a),
    quizCatalog: (...a: unknown[]) => quizCatalog(a),
    funnelSegments: (...a: unknown[]) => funnelSegments(a),
  };
});

const { loadFunnelView } = await import('./funnel');
const { parseFilters } = await import('./filters');
const { QUIZ_VARIANT } = await import('@repo/shared/quiz-variant');

function catalogRow(over: Partial<CatalogRow> & { step_id: string }): CatalogRow {
  return {
    quiz_variant: QUIZ_VARIANT,
    app_key: 'acme',
    funnel_key: 'main',
    first_step_id: 'step1',
    total_steps: 3,
    config_hash: 'a'.repeat(64),
    published_at: '2026-09-01T00:00:00Z',
    step_position: 1,
    sort_index: 1,
    step_type: 'radio',
    phase_key: null,
    store_as: null,
    label: 'A question',
    is_question: true,
    is_terminal: false,
    is_unconditional: true,
    entry_skippable: false,
    answer_keys: [],
    option_values: [],
    option_labels: {},
    ...over,
  };
}

function funnelRow(over: Partial<CroStepFunnelRow> & { step_id: string }): CroStepFunnelRow {
  return {
    quiz_variant: QUIZ_VARIANT,
    funnel_variant: 'main-v1',
    step_position: 1,
    sort_index: 1,
    step_type: 'radio',
    phase_key: null,
    label: 'A question',
    is_question: true,
    is_terminal: false,
    is_unconditional: true,
    entry_skippable: false,
    in_catalog: true,
    has_traffic: true,
    position_cohort: 0,
    viewed: 100,
    answered: 90,
    skipped: 0,
    advanced: 90,
    dropped: 10,
    unsettled: 0,
    total_views: 100,
    revisits: 0,
    p50_seconds_to_answer: null,
    p90_seconds_to_answer: null,
    ...over,
  };
}

beforeEach(() => {
  stepFunnel.mockReset();
  quizCatalog.mockReset();
  funnelSegments.mockReset();
  stepFunnel.mockResolvedValue([funnelRow({ step_id: 'step1' })]);
  funnelSegments.mockResolvedValue([]);
});

const FILTERS = parseFilters({}, new Date('2026-09-14T11:30:00.000Z'));

describe('loadFunnelView — the catalog envelope', () => {
  it('carries configHash through, so the catalog warning can stay silent', async () => {
    quizCatalog.mockResolvedValue([catalogRow({ step_id: 'step1' })]);
    const { view } = await loadFunnelView(FILTERS);
    expect(view.quiz.configHash).toBe('a'.repeat(64));
    expect(view.warnings.map((w) => w.code)).not.toContain('CATALOG_NOT_PUBLISHED');
  });

  it('leaves configHash NULL on an empty catalog, so the warning fires', async () => {
    // The whole reason this test exists. An envelope that defaulted the hash to
    // a string would disable the warning permanently, with no symptom.
    quizCatalog.mockResolvedValue([]);
    const { view } = await loadFunnelView(FILTERS);
    expect(view.quiz.configHash).toBeNull();
    expect(view.warnings.map((w) => w.code)).toContain('CATALOG_NOT_PUBLISHED');
  });

  it('does not also claim steps were retired when nothing was ever published', async () => {
    quizCatalog.mockResolvedValue([]);
    stepFunnel.mockResolvedValue([funnelRow({ step_id: 'step1', in_catalog: false })]);
    const { view } = await loadFunnelView(FILTERS);
    expect(view.warnings.map((w) => w.code)).not.toContain('RETIRED_STEPS');
  });

  it('collects every terminal step, which is how "reached the end" is counted', async () => {
    quizCatalog.mockResolvedValue([
      catalogRow({ step_id: 'step1' }),
      catalogRow({ step_id: 'step3', is_terminal: true, step_position: 3, sort_index: 3 }),
      catalogRow({ step_id: 'step3b', is_terminal: true, step_position: 3, sort_index: 4 }),
    ]);
    const { view } = await loadFunnelView(FILTERS);
    expect(view.quiz.terminalStepIds).toEqual(['step3', 'step3b']);
  });

  it('takes totalSteps from the catalog, which gives each position its share', async () => {
    quizCatalog.mockResolvedValue([catalogRow({ step_id: 'step1', total_steps: 9 })]);
    const { view } = await loadFunnelView(FILTERS);
    expect(view.quiz.totalSteps).toBe(9);
  });
});

describe('loadFunnelView — which version it reports on', () => {
  beforeEach(() => quizCatalog.mockResolvedValue([catalogRow({ step_id: 'step1' })]));

  it('defaults to this build, never to a blend', async () => {
    const { quizVariant } = await loadFunnelView(FILTERS);
    expect(quizVariant).toBe(QUIZ_VARIANT);
    expect(quizCatalog).toHaveBeenCalledWith([QUIZ_VARIANT]);
  });

  it('resolves ?v=all to ONE version, because the assembler merges by step id', async () => {
    // Blending is unreachable here by construction rather than by remembering:
    // two versions where one moved a question would produce a plausible chart
    // with the wrong position and the wrong label.
    const blended = parseFilters({ v: 'all' }, new Date('2026-09-14T11:30:00.000Z'));
    expect(blended.quizVersion).toBeUndefined();
    const { quizVariant } = await loadFunnelView(blended);
    expect(quizVariant).toBe(QUIZ_VARIANT);
  });

  it('asks the catalog for the SAME version it asked the funnel for', async () => {
    const pinned = parseFilters({ v: 'retired-v0' }, new Date('2026-09-14T11:30:00.000Z'));
    await loadFunnelView(pinned);
    expect(quizCatalog).toHaveBeenCalledWith(['retired-v0']);
    expect(stepFunnel).toHaveBeenCalledWith([expect.anything(), pinned, 'retired-v0']);
  });

  it('fetches segments unfiltered, so an empty window still offers a way back', async () => {
    await loadFunnelView(FILTERS);
    const [[range]] = funnelSegments.mock.calls[0]!;
    expect(range).toEqual(expect.objectContaining({ from: expect.any(String) }));
    expect(funnelSegments).toHaveBeenCalledTimes(1);
  });
});
