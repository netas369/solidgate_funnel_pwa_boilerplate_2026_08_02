import { MAX_WINDOW_DAYS, type DashboardFilters } from '@/lib/filters';


/**
 * The note shown when a requested window was clamped to what the picker offers.
 *
 * Inherited from carnivore-app's RangePicker.tsx, which by then exported only
 * this. Renamed to what it actually contains — the period chips live in
 * FilterBar now.
 *
 * The clamp is a UX cap, NOT a data boundary. The reference apps prune their
 * raw event table past 90 days and the note said so; this schema has no such
 * table and no prune job, so the honest wording is that the picker does not
 * offer longer, not that the data stops.
 */
export function RetentionNote({
  clamped,
  filters,
}: {
  clamped: boolean;
  filters: DashboardFilters;
}) {
  if (!clamped || !filters.from) return null;
  const shown = new Date(`${filters.from}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <p className="text-xs text-ink-faint">
      The picker goes back {MAX_WINDOW_DAYS} days — showing from {shown}.
    </p>
  );
}
