// server-only — never import from a 'use client' file.
// Consumed by: proxy.ts (Plan 03), /api/admin/auth/* (Plan 03),
//              _queries/*.ts (Plan 04), _actions/*.ts (Plan 06).

import {
  getAdminAccessForEmail,
  hasAdminCapability,
  parseAdminAccess,
  type AdminCapability,
} from '@repo/admin-core/access';
import { adminConfig } from '@/admin.config';

/** Backward-compatible view of every configured role-aware access entry. */
export const ADMIN_EMAILS: readonly string[] = parseAdminAccess().entries.map(
  (entry) => entry.email,
);

/** True when email is non-null AND case-insensitively present in ADMIN_EMAILS. */
export function isAdminEmail(email: string | null | undefined): boolean {
  return getAdminAccessForEmail(email) !== null;
}

export function adminEmailHasCapability(
  email: string | null | undefined,
  capability: AdminCapability,
): boolean {
  return hasAdminCapability(getAdminAccessForEmail(email), capability);
}

export function adminLandingPathForEmail(
  email: string | null | undefined,
): '/admin/dashboard' | '/admin/support' | '/admin/audit' | '/admin/health' | '/' {
  const access = getAdminAccessForEmail(email);
  const dashboardEnabled = Object.entries(adminConfig.modules).some(
    ([key, enabled]) =>
      key !== 'support' && key !== 'audit' && key !== 'health' && enabled,
  );
  if (dashboardEnabled && hasAdminCapability(access, 'analytics:view')) {
    return '/admin/dashboard';
  }
  if (adminConfig.modules.support && hasAdminCapability(access, 'support:view')) {
    return '/admin/support';
  }
  if (adminConfig.modules.audit && hasAdminCapability(access, 'admin:manage')) {
    return '/admin/audit';
  }
  if (adminConfig.modules.health && hasAdminCapability(access, 'admin:manage')) {
    return '/admin/health';
  }
  return '/';
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
