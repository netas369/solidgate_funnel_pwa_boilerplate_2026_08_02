'use client';

// D-18: Recharts LineChart wrapper. MUST be a client component because Recharts
// touches ResizeObserver / useLayoutEffect / SVG measurement. Consumers pass
// pre-aggregated JSON (no Supabase, no fetching) — keeping the client bundle
// thin and the trust boundary at the Server Component layer.

import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { ChartContainer } from './ChartContainer';

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface TimeSeriesLineProps {
  data: TimeSeriesPoint[];
  yLabel?: string;
  color?: string;
}

export function TimeSeriesLine({
  data,
  yLabel,
  color = '#0ea5e9',
}: TimeSeriesLineProps) {
  return (
    <ChartContainer>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis
          tick={{ fontSize: 11 }}
          label={
            yLabel
              ? { value: yLabel, angle: -90, position: 'insideLeft', fontSize: 11 }
              : undefined
          }
        />
        <Tooltip />
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
