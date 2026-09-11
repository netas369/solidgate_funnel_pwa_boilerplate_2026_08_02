import { describe, expect, it } from 'vitest';
import {
  getAdminAccessForEmail,
  hasAdminCapability,
  parseAdminAccess,
} from '../access';

describe('admin access policy', () => {
  it('parses role-aware access and normalizes exact emails', () => {
    const parsed = parseAdminAccess({
      ADMIN_ACCESS: 'Owner@Example.com:administrator,agent@example.com:support',
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.source).toBe('ADMIN_ACCESS');
    expect(getAdminAccessForEmail(' owner@example.com ', {
      ADMIN_ACCESS: 'Owner@Example.com:administrator,agent@example.com:support',
    })?.role).toBe('administrator');
    expect(hasAdminCapability(parsed.entries[1], 'support:act')).toBe(true);
    expect(hasAdminCapability(parsed.entries[1], 'analytics:view')).toBe(false);
  });

  it('uses ADMIN_EMAILS only as a backward-compatible administrator fallback', () => {
    const parsed = parseAdminAccess({ ADMIN_EMAILS: 'admin@example.com' });
    expect(parsed.entries[0]?.role).toBe('administrator');
  });

  it('fails closed for malformed and conflicting entries', () => {
    const parsed = parseAdminAccess({
      ADMIN_ACCESS:
        'missing-role,person@example.com:support,person@example.com:analyst',
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toHaveLength(2);
  });
});
