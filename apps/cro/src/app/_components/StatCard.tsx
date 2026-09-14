/**
 * A headline number.
 *
 * Deliberately a big jump — eyebrow label at 11px, number at 34px, nothing in
 * between. The previous version sat everything within a few points of 13px, so
 * the eye had nothing to follow and the page read as undifferentiated.
 */
export function StatCard({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="label-eyebrow">{label}</div>
      <div className="mt-2 text-3xl font-semibold leading-none tabular-nums text-ink">
        {value}
      </div>
      {unit ? <div className="mt-2 text-xs text-ink-faint">{unit}</div> : null}
    </div>
  );
}
