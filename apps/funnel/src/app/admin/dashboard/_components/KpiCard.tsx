// D-12: server-safe card (no client directive) rendering ONE metric label
// above THREE fixed buckets shown side-by-side: Today / 7d / 30d.
// Values arrive as already-formatted strings so the same component works
// for counts ("42") and currency ("€1,234").

export interface KpiCardProps {
  label: string;
  today: string;
  sevenD: string;
  thirtyD: string;
}

export function KpiCard({ label, today, sevenD, thirtyD }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 text-sm font-medium text-neutral-600">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <Bucket caption="Today" value={today} />
        <Bucket caption="7d" value={sevenD} />
        <Bucket caption="30d" value={thirtyD} />
      </div>
    </div>
  );
}

function Bucket({ caption, value }: { caption: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {caption}
      </div>
      <div className="mt-1 text-2xl font-semibold text-neutral-900">{value}</div>
    </div>
  );
}
