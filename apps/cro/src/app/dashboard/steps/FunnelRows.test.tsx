import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  assembleFunnelResponse,
  type CroStepFunnelRow,
} from '@repo/shared/cro/funnel-response';
import { parseFilters } from '@/lib/filters';
import { PositionRow } from './FunnelRows';

afterEach(cleanup);

/**
 * Driven through the REAL assembler rather than hand-built AssembledPosition
 * literals. Every number these rows render is precomputed upstream, so a
 * fixture written by hand would only be asserting that the fixture was copied
 * into the JSX correctly — it would keep passing after the assembler's
 * semantics changed underneath it.
 */
function row(over: Partial<CroStepFunnelRow> & { step_id: string }): CroStepFunnelRow {
  return {
    quiz_variant: 'boilerplate-v1',
    funnel_variant: 'main-v1',
    step_position: 1,
    sort_index: 1,
    step_type: 'radio',
    phase_key: null,
    label: `Label for ${over.step_id}`,
    is_question: true,
    is_terminal: false,
    is_unconditional: true,
    entry_skippable: false,
    in_catalog: true,
    has_traffic: true,
    position_cohort: 0,
    viewed: 0,
    answered: 0,
    skipped: 0,
    advanced: 0,
    dropped: 0,
    unsettled: 0,
    total_views: 0,
    revisits: 0,
    p50_seconds_to_answer: null,
    p90_seconds_to_answer: null,
    ...over,
  };
}

function assemble(rows: CroStepFunnelRow[]) {
  return assembleFunnelResponse(rows, {
    quizVariant: 'boilerplate-v1',
    configHash: 'a'.repeat(64),
    firstStepId: 'step1',
    totalSteps: 3,
    terminalStepIds: ['step3'],
    range: { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' },
    generatedAt: '2026-09-14T00:00:00Z',
  });
}

const FILTERS = parseFilters({}, new Date('2026-09-14T11:30:00.000Z'));

function renderPositions(
  rows: CroStepFunnelRow[],
  { showArms = false, showDetail = false } = {},
) {
  const view = assemble(rows);
  render(
    <ol>
      {view.steps.map((group) => (
        <PositionRow
          key={group.position ?? `retired:${group.lead.stepId}`}
          group={group}
          showArms={showArms}
          showDetail={showDetail}
          filters={FILTERS}
        />
      ))}
    </ol>,
  );
  return view;
}

/** step1 → step2 (+ a companion and a branch) → step3 (terminal). */
function baseRows(): CroStepFunnelRow[] {
  return [
    row({ step_id: 'step1', step_position: 1, sort_index: 1, viewed: 1000, answered: 900, dropped: 100 }),
    row({ step_id: 'step2', step_position: 2, sort_index: 2, viewed: 900, answered: 800, dropped: 100 }),
    row({ step_id: 'step2c', step_position: 2, sort_index: 3, viewed: 800, answered: 780, dropped: 20 }),
    row({
      step_id: 'step2b', step_position: 2, sort_index: 4, is_unconditional: false,
      viewed: 300, answered: 90, dropped: 210,
    }),
    row({
      step_id: 'step3', step_position: 3, sort_index: 5, is_terminal: true, is_question: false,
      viewed: 700, answered: 0,
    }),
  ];
}

describe('companions and branches', () => {
  it('always shows a companion, because everyone walks through it', () => {
    renderPositions(baseRows());
    expect(screen.getByTitle('step2c')).toBeInTheDocument();
    expect(screen.getByText('Everyone sees this')).toBeInTheDocument();
  });

  it('folds a branch away until asked for', () => {
    renderPositions(baseRows());
    expect(screen.queryByTitle('step2b')).toBeNull();
  });

  it('shows the branch once asked', () => {
    renderPositions(baseRows(), { showArms: true });
    expect(screen.getByTitle('step2b')).toBeInTheDocument();
    expect(screen.getByText('Only some visitors')).toBeInTheDocument();
  });

  it('announces a heavy branch drop from the COLLAPSED row', () => {
    // Collapsing hides the branch's whole drop, so the default view would
    // otherwise be a lie by omission: step2b loses 70% and is not on screen.
    renderPositions(baseRows());
    expect(screen.getByText(/A branch screen here loses 70%/)).toBeInTheDocument();
  });

  it('drops the alert once the branch is visible for itself', () => {
    renderPositions(baseRows(), { showArms: true });
    expect(screen.queryByText(/A branch screen here loses/)).toBeNull();
  });
});

describe('badges carry a traffic floor', () => {
  it('badges a heavy drop with real traffic', () => {
    renderPositions([
      row({ step_id: 'step1', step_position: 1, sort_index: 1, viewed: 1000, answered: 400, dropped: 600 }),
    ]);
    expect(screen.getByText('Most people leave here')).toBeInTheDocument();
  });

  it('stays quiet when the whole funnel is a small sample', () => {
    // 8 people is not evidence of anything. dropSeverity has no floor of its
    // own, so without showBadge a screen eight people saw shouts.
    renderPositions([
      row({ step_id: 'step1', step_position: 1, sort_index: 1, viewed: 8, answered: 2, dropped: 6 }),
    ]);
    expect(screen.queryByText('Most people leave here')).toBeNull();
  });
});

describe('retired steps', () => {
  const rows = [
    ...baseRows(),
    row({
      step_id: 'stepOld', in_catalog: false, step_position: null, sort_index: null,
      label: null, viewed: 40, answered: 10, dropped: 30,
    }),
  ];

  it('renders them without a position, a bar or a change', () => {
    // The branch neither reference has. Without it the row shows a display
    // index of null and a bar computed from a null position.
    renderPositions(rows);
    const retired = screen.getByText('No longer in the quiz').closest('li')!;
    expect(within(retired).getByText('—')).toBeInTheDocument();
    expect(within(retired).queryByText(/reached/)).toBeNull();
  });

  it('falls back to the step id when the catalog has no label', () => {
    renderPositions(rows);
    expect(screen.getByText('stepOld')).toBeInTheDocument();
  });

  it('leaves the live questions numbered consecutively', () => {
    const view = renderPositions(rows);
    expect(view.steps.filter((s) => !s.retired).map((s) => s.displayIndex)).toEqual([1, 2, 3]);
  });
});

describe('counts that must not be added together', () => {
  it('reports people still mid-quiz separately from the drop', () => {
    renderPositions([
      row({
        step_id: 'step1', step_position: 1, sort_index: 1,
        viewed: 100, answered: 60, dropped: 25, unsettled: 15,
      }),
    ]);
    expect(screen.getByText(/25 left here \(25%\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/15 were still on this question when the report ran/),
    ).toBeInTheDocument();
  });

  it('explains a skipped question rather than counting it as a loss', () => {
    renderPositions([
      row({
        step_id: 'step1', step_position: 1, sort_index: 1, entry_skippable: true,
        viewed: 100, answered: 95, dropped: 5, skipped: 400,
      }),
    ]);
    expect(
      screen.getByText(/400 never saw this question — an earlier answer had already settled it/),
    ).toBeInTheDocument();
  });
});

describe('timing detail', () => {
  const rows = [
    row({
      step_id: 'step1', step_position: 1, sort_index: 1, viewed: 100, answered: 90, dropped: 10,
      p50_seconds_to_answer: 4.2, p90_seconds_to_answer: 31,
    }),
  ];

  it('is hidden by default — it is the second question, not the first', () => {
    renderPositions(rows);
    expect(screen.queryByText('Typical time')).toBeNull();
  });

  it('appears on request', () => {
    renderPositions(rows, { showDetail: true });
    expect(screen.getByText('Typical time')).toBeInTheDocument();
    expect(screen.getByText('Answered it')).toBeInTheDocument();
  });
});
