import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

// GREEN (Plan 05): ../TimeSeriesLine is implemented as a `'use client'` Recharts
// LineChart wrapper. This jsdom smoke test asserts D-18 SSR-safety: the
// component mounts with empty data in jsdom without throwing
// (Recharts/ResponsiveContainer historically blew up on missing ResizeObserver).

describe('TimeSeriesLine (D-18 SSR-safety)', () => {
  it('renders without throwing in jsdom with empty data', async () => {
    const { TimeSeriesLine } = await import('../TimeSeriesLine');
    expect(() => {
      const { unmount } = render(<TimeSeriesLine data={[]} />);
      unmount();
    }).not.toThrow();
  });

  it('renders without throwing in jsdom with sample data', async () => {
    const { TimeSeriesLine } = await import('../TimeSeriesLine');
    expect(() => {
      const { unmount } = render(
        <TimeSeriesLine
          data={[
            { date: '2026-05-01', value: 12 },
            { date: '2026-05-02', value: 7 },
          ]}
          yLabel="Sessions"
        />,
      );
      unmount();
    }).not.toThrow();
  });
});
