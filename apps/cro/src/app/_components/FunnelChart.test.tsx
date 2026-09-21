import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  assembleFunnelResponse,
  type CroStepFunnelRow,
} from '@repo/shared/cro/funnel-response';
import { FunnelChart } from './FunnelChart';

afterEach(cleanup);

function row(over: Partial<CroStepFunnelRow> & { step_id: string }): CroStepFunnelRow {
  return {
    quiz_variant: 'v1',
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

function view(rows: CroStepFunnelRow[]) {
  return assembleFunnelResponse(rows, {
    quizVariant: 'v1',
    configHash: 'a'.repeat(64),
    firstStepId: 'step1',
    totalSteps: 3,
    terminalStepIds: ['step3'],
    range: { from: '2026-09-01T00:00:00Z', to: '2026-09-08T00:00:00Z' },
    generatedAt: '2026-09-14T00:00:00Z',
  });
}

function chart(rows: CroStepFunnelRow[], finished = 0) {
  const v = view(rows);
  const { container } = render(<FunnelChart rows={v.steps} finished={finished} />);
  return { container, v };
}

const THREE = [
  row({ step_id: 'step1', step_position: 1, sort_index: 1, viewed: 1000, answered: 900, dropped: 100 }),
  row({ step_id: 'step2', step_position: 2, sort_index: 2, viewed: 900, answered: 400, dropped: 500 }),
  row({ step_id: 'step3', step_position: 3, sort_index: 3, is_terminal: true, viewed: 400 }),
];

describe('FunnelChart', () => {
  it('draws one point per POSITION, never per screen', () => {
    // A branch arm shares its question's slot. Plotting it would put two points
    // on one x and draw a spike where the quiz merely showed a second card.
    const withArm = [
      ...THREE,
      row({
        step_id: 'step2b', step_position: 2, sort_index: 4, is_unconditional: false,
        viewed: 300, answered: 200, dropped: 100,
      }),
    ];
    const { container } = chart(withArm, 400);
    expect(container.querySelectorAll('title')).toHaveLength(3);
  });

  it('starts the Y axis at zero, so no decline is exaggerated', () => {
    const { container } = chart(THREE, 400);
    const ticks = [...container.querySelectorAll('text')].map((t) => t.textContent);
    expect(ticks).toContain('0');
  });

  it('uses round axis numbers, because an axis is a ruler', () => {
    // Slicing a peak into fifths gives 1,204 / 903 / 602 — unreadable.
    const { container } = chart(THREE, 400);
    const numeric = [...container.querySelectorAll('text')]
      .map((t) => Number((t.textContent ?? '').replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n >= 100);
    for (const tick of numeric) expect(tick % 50).toBe(0);
  });

  it('leaves out retired steps, which are not a slot anyone walks through', () => {
    const withRetired = [
      ...THREE,
      row({ step_id: 'gone', in_catalog: false, step_position: null, sort_index: null, viewed: 40 }),
    ];
    const { container } = chart(withRetired, 400);
    expect(container.querySelectorAll('title')).toHaveLength(3);
  });

  it('renders nothing rather than an empty frame when every step is retired', () => {
    const { container } = chart(
      [row({ step_id: 'gone', in_catalog: false, step_position: null, sort_index: null, viewed: 40 })],
      0,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('describes the whole shape to a screen reader', () => {
    chart(THREE, 400);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toMatch(/1,000 reach the first question/);
    expect(svg.getAttribute('aria-label')).toMatch(/400 reach the end/);
  });

  it('takes `finished` as a prop rather than reading the last plotted row', () => {
    // In a window where nobody got past question 2, the last row IS question 2,
    // and calling its answers "the finish" flatters the funnel badly.
    const stalled = THREE.slice(0, 2);
    chart(stalled, 0);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/0 reach the end/);
  });

  it('caveats a small sample instead of hiding the chart', () => {
    // This was briefly a threshold that replaced the chart with a message,
    // which silently deleted the feature on a real 17-person dataset.
    const { container } = chart(
      [row({ step_id: 'step1', viewed: 9, answered: 5, dropped: 4 })],
      0,
    );
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.getByText(/single visitors move the line noticeably/)).toBeInTheDocument();
  });

  it('centres a lone point instead of dividing by zero', () => {
    const { container } = chart([row({ step_id: 'step1', viewed: 50, answered: 40, dropped: 10 })], 0);
    const cx = container.querySelector('circle')?.getAttribute('cx');
    expect(Number(cx)).toBeGreaterThan(0);
    expect(Number.isNaN(Number(cx))).toBe(false);
  });

  it('marks the cliff once, and only when it is heavy', () => {
    const { container } = chart(THREE, 400);
    expect(screen.getByText(/leave at question 2/)).toBeInTheDocument();
    expect(container.querySelectorAll('[stroke-dasharray]')).toHaveLength(1);
  });

  it('marks nothing when no question loses heavily', () => {
    const gentle = [
      row({ step_id: 'step1', step_position: 1, sort_index: 1, viewed: 1000, answered: 980, dropped: 20 }),
      row({ step_id: 'step2', step_position: 2, sort_index: 2, viewed: 980, answered: 960, dropped: 20 }),
    ];
    const { container } = chart(gentle, 960);
    expect(container.querySelectorAll('[stroke-dasharray]')).toHaveLength(0);
  });
});
