// server-only — never import from a 'use client' file.
// Consumed by: proxy.ts (Plan 03), /api/admin/auth/* (Plan 03),
//              _queries/*.ts (Plan 04), _actions/*.ts (Plan 06).

/**
 * Comma-separated, lowercased on read. v1 expects one email but supports many.
 * Empty string env → empty allowlist (no admin access).
 */
export const ADMIN_EMAILS: readonly string[] = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** True when email is non-null AND case-insensitively present in ADMIN_EMAILS. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/** ISO-8601 UTC bounds. `from` inclusive, `to` exclusive. */
export interface DateRange {
  /** ISO-8601 UTC inclusive lower bound. */
  from: string;
  /** ISO-8601 UTC exclusive upper bound. */
  to: string;
}

/**
 * Bucket ISO timestamps into per-UTC-day counts.
 * Returns sorted ascending by date. Empty days are NOT filled —
 * chart components can pad if a continuous axis is needed.
 */
export function bucketByDay(
  timestamps: string[],
): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    // YYYY-MM-DD in UTC
    const key = d.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
