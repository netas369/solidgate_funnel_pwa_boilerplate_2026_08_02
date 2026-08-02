// D-15 Suspense fallbacks. Server-safe (no client directive) so they can be
// returned from any Server Component's <Suspense fallback={...}> without
// bloating the client bundle. Tailwind handles the animated shimmer.

export function KpiCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-32 animate-pulse rounded-lg bg-neutral-100" />
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-neutral-100"
      style={{ height }}
    />
  );
}

export function BarSkeleton() {
  return <ChartSkeleton height={180} />;
}

export function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-neutral-100" />
      ))}
    </div>
  );
}
