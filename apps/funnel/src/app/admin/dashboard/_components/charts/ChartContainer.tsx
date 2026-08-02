'use client';

// D-18 SSR-safety: Recharts' ResponsiveContainer touches ResizeObserver and
// useLayoutEffect, both of which require a 'use client' boundary so Next.js
// doesn't try to render them on the server. This wrapper centralizes sizing
// so consumers (TimeSeriesLine, HorizontalBar) don't repeat the boilerplate.

import type { ReactElement, ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';

export interface ChartContainerProps {
  children: ReactNode;
  height?: number;
}

export function ChartContainer({ children, height = 240 }: ChartContainerProps) {
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Recharts expects a SINGLE chart element child (LineChart, BarChart, …). */}
        {children as ReactElement}
      </ResponsiveContainer>
    </div>
  );
}
