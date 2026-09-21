import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SegmentRow } from '@/lib/queries';
import { SegmentTable } from './SegmentTable';

afterEach(cleanup);

function row(over: Partial<SegmentRow> & { bucket: string }): SegmentRow {
  return {
    dimension: 'locale',
    sessions: 100,
    with_activity: 80,
    completed: 20,
    completion_pct: 25,
    median_max_position: 3,
    p90_max_position: 6,
    max_position_reached: 7,
    ...over,
  };
}

const render1 = (rows: SegmentRow[]) =>
  render(<SegmentTable title="Language" hint="How far they get." rows={rows} label={(b) => b} />);

describe('SegmentTable', () => {
  it('renders nothing for a dimension with no rows', () => {
    const { container } = render1([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('names a real question for a whole median', () => {
    render1([row({ bucket: 'en', median_max_position: 3 })]);
    expect(screen.getByText('question 3')).toBeInTheDocument();
  });

  it('renders an interpolated median as an interval, never "question 3.5"', () => {
    // percentile_cont interpolates on purpose — rounding in SQL would throw
    // away an eighth of a seven-step funnel — but a half-question does not
    // exist, so the wording is what has to give.
    render1([row({ bucket: 'en', median_max_position: 3.5 })]);
    expect(screen.getByText('question 3–4')).toBeInTheDocument();
    expect(screen.queryByText(/3\.5/)).toBeNull();
  });

  it('shows a dash rather than a number when nobody got anywhere', () => {
    render1([row({ bucket: 'en', median_max_position: null })]);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('withholds a completion rate when nobody started answering', () => {
    // 0 of 0 is not 0%. A group that only ever opened the page has no
    // completion rate, and printing one would rank it against groups that do.
    render1([row({ bucket: 'en', with_activity: 0, completed: 0, completion_pct: 0 })]);
    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('scales each row against the busiest in ITS OWN table', () => {
    render1([
      row({ bucket: 'en', sessions: 100 }),
      row({ bucket: 'de', sessions: 50 }),
    ]);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    // Shares are of this dimension's total, so they sum to 100 within the table.
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('33%')).toBeInTheDocument();
  });

  it('passes the bucket code through the label function', () => {
    render(
      <SegmentTable
        title="Device"
        hint="x"
        rows={[row({ bucket: 'mobile' })]}
        label={(b) => b.toUpperCase()}
      />,
    );
    expect(screen.getByText('MOBILE')).toBeInTheDocument();
  });
});
