export type AdminRole = 'administrator' | 'support' | 'analyst' | 'viewer';

export type AdminCapability =
  | 'analytics:view'
  | 'support:view'
  | 'support:act'
  | 'admin:manage';

export interface AdminAccessEntry {
  email: string;
  role: AdminRole;
  capabilities: readonly AdminCapability[];
}

export interface AdminAccessParseResult {
  entries: readonly AdminAccessEntry[];
  errors: readonly string[];
  source: 'ADMIN_ACCESS' | 'ADMIN_EMAILS' | 'none';
}

const ROLE_CAPABILITIES: Readonly<Record<AdminRole, readonly AdminCapability[]>> = {
  administrator: ['analytics:view', 'support:view', 'support:act', 'admin:manage'],
  support: ['support:view', 'support:act'],
  analyst: ['analytics:view'],
  viewer: ['analytics:view', 'support:view'],
};

const ROLES = new Set<AdminRole>(['administrator', 'support', 'analyst', 'viewer']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAdminEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * ADMIN_ACCESS format: `email:role,email:role`.
 * When ADMIN_ACCESS is present it replaces the legacy ADMIN_EMAILS list.
 * Invalid entries are omitted so malformed access configuration fails closed.
 */
export function parseAdminAccess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdminAccessParseResult {
  const rawAccess = env.ADMIN_ACCESS?.trim();
  const rawLegacy = env.ADMIN_EMAILS?.trim();
  const errors: string[] = [];
  const rolesByEmail = new Map<string, AdminRole>();

  if (rawAccess) {
    for (const item of rawAccess.split(',')) {
      const separator = item.lastIndexOf(':');
      const email = normalizeAdminEmail(separator >= 0 ? item.slice(0, separator) : '');
      const role = (separator >= 0 ? item.slice(separator + 1) : '').trim() as AdminRole;
      if (!email || !ROLES.has(role)) {
        errors.push(`invalid ADMIN_ACCESS entry: ${item.trim() || '<empty>'}`);
        continue;
      }
      if (rolesByEmail.has(email) && rolesByEmail.get(email) !== role) {
        errors.push(`conflicting roles for ${email}`);
        rolesByEmail.delete(email);
        continue;
      }
      rolesByEmail.set(email, role);
    }
  } else if (rawLegacy) {
    for (const item of rawLegacy.split(',')) {
      const email = normalizeAdminEmail(item);
      if (!email) {
        errors.push(`invalid ADMIN_EMAILS entry: ${item.trim() || '<empty>'}`);
        continue;
      }
      rolesByEmail.set(email, 'administrator');
    }
  }

  return {
    entries: [...rolesByEmail.entries()].map(([email, role]) => ({
      email,
      role,
      capabilities: ROLE_CAPABILITIES[role],
    })),
    errors,
    source: rawAccess ? 'ADMIN_ACCESS' : rawLegacy ? 'ADMIN_EMAILS' : 'none',
  };
}

export function getAdminAccessForEmail(
  email: string | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AdminAccessEntry | null {
  const normalized = normalizeAdminEmail(email);
  if (!normalized) return null;
  return parseAdminAccess(env).entries.find((entry) => entry.email === normalized) ?? null;
}

export function hasAdminCapability(
  access: AdminAccessEntry | null | undefined,
  capability: AdminCapability,
): boolean {
  return Boolean(access?.capabilities.includes(capability));
}
