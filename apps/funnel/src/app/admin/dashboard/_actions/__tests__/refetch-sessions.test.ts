import { beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 06): ../refetch-sessions exposes refetchSessions(range) which:
//   - throws Forbidden when the calling user fails isAdminEmail() (D-19, T-06-01)
//   - returns serialized { timeSeries, byLocale } payload for valid range

const VALID_RANGE = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-05-08T00:00:00.000Z',
};

describe('refetchSessions server action (Plan 06 implements D-19)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-svc';
  });

  it('non-admin forbidden: throws Forbidden when isAdminEmail returns false', async () => {
    vi.doMock('@repo/shared/supabase/server', () => ({
      createClient: vi.fn(async () => ({
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: { email: 'intruder@example.com' } },
            error: null,
          })),
        },
      })),
    }));
    // Mock query modules so any accidental call would NOT silently succeed.
    vi.doMock('../../../_queries/sessions', () => ({
      sessionsTimeSeries: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../../_queries/locales', () => ({
      sessionsByLocale: vi.fn().mockResolvedValue([]),
    }));

    const { refetchSessions } = await import('../refetch-sessions');
    await expect(refetchSessions(VALID_RANGE)).rejects.toThrow('Forbidden');
  });

  it('valid range: returns serialized {timeSeries, byLocale} payload', async () => {
    vi.doMock('@repo/shared/supabase/server', () => ({
      createClient: vi.fn(async () => ({
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: { email: 'admin@example.com' } },
            error: null,
          })),
        },
      })),
    }));
    const ts = [
      { date: '2026-05-01', count: 3 },
      { date: '2026-05-02', count: 1 },
    ];
    const locales = [
      { locale: 'en', count: 3, sharePct: 75.0 },
      { locale: 'fr', count: 1, sharePct: 25.0 },
    ];
    vi.doMock('../../../_queries/sessions', () => ({
      sessionsTimeSeries: vi.fn().mockResolvedValue(ts),
    }));
    vi.doMock('../../../_queries/locales', () => ({
      sessionsByLocale: vi.fn().mockResolvedValue(locales),
    }));

    const { refetchSessions } = await import('../refetch-sessions');
    const result = await refetchSessions(VALID_RANGE);
    expect(result).toEqual({ timeSeries: ts, byLocale: locales });
  });
});
