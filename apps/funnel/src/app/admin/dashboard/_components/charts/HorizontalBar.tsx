'use client';

// D-18: Recharts BarChart (horizontal layout) wrapper. Same SSR-safety
// reasoning as TimeSeriesLine — kept as a thin client wrapper that accepts
// pre-aggregated JSON only. Height scales with row count so locale
// breakdowns with many rows don't crush their labels.

import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ChartContainer } from './ChartContainer';

export interface BarDatum {
  label: string;
  value: number;
}

export interface HorizontalBarProps {
  data: BarDatum[];
  color?: string;
}

export function HorizontalBar({ data, color = '#10b981' }: HorizontalBarProps) {
  return (
    <ChartContainer height={Math.max(120, data.length * 28)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 24, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis type="number" tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={64} />
        <Tooltip />
        <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
