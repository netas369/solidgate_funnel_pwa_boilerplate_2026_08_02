import { beforeEach, describe, expect, it, vi } from 'vitest';

// _shared.ts reads process.env.ADMIN_EMAILS at module-load. Reset modules in
// beforeEach so each test can install its own env and re-trigger the parse.
describe('_shared.isAdminEmail', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ADMIN_EMAILS;
  });

  it('returns true for case-insensitive match when env contains the email', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com, second@example.com';
    const { isAdminEmail } = await import('../_shared');
    expect(isAdminEmail('Admin@Example.COM')).toBe(true);
    expect(isAdminEmail('second@example.com')).toBe(true);
  });

  it('returns false for null/undefined/empty/unlisted emails', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const { isAdminEmail } = await import('../_shared');
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail('')).toBe(false);
    expect(isAdminEmail('other@example.com')).toBe(false);
  });

  it('returns false for ANY email when ADMIN_EMAILS env is unset', async () => {
    delete process.env.ADMIN_EMAILS;
    const { isAdminEmail } = await import('../_shared');
    expect(isAdminEmail('admin@example.com')).toBe(false);
  });
});

describe('_shared.bucketByDay', () => {
  it('buckets timestamps into per-UTC-day counts sorted ascending', async () => {
    const { bucketByDay } = await import('../_shared');
    const out = bucketByDay([
      '2026-05-17T10:00:00Z',
      '2026-05-17T14:00:00Z',
      '2026-05-18T01:00:00Z',
    ]);
    expect(out).toEqual([
      { date: '2026-05-17', count: 2 },
      { date: '2026-05-18', count: 1 },
    ]);
  });

  it('returns [] for empty input', async () => {
    const { bucketByDay } = await import('../_shared');
    expect(bucketByDay([])).toEqual([]);
  });

  it('skips invalid timestamps', async () => {
    const { bucketByDay } = await import('../_shared');
    const out = bucketByDay(['2026-05-17T10:00:00Z', 'not-a-date', '']);
    expect(out).toEqual([{ date: '2026-05-17', count: 1 }]);
  });
});
