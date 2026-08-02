import { beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 04): ../locales exposes sessionsByLocale(range) ->
// Array<{locale, count, sharePct}> sorted desc by count.

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

describe('locales query (GREEN — Plan 04 implementation)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it('sessionsByLocale buckets by locale column, sorted desc by count', async () => {
    const rows = [
      { locale: 'en' },
      { locale: 'cs' },
      { locale: 'en' },
      { locale: 'en' },
      { locale: 'pl' },
      { locale: 'cs' },
    ];
    const builder = {
      select: vi.fn(() => ({
        gte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({ data: rows, error: null }),
      })),
    };
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          expect(table).toBe('sessions');
          return builder;
        }),
      }),
    }));
    const { sessionsByLocale } = await import('../locales');
    const result = await sessionsByLocale(RANGE);
    expect(result).toEqual([
      { locale: 'en', count: 3, sharePct: 50 },
      { locale: 'cs', count: 2, sharePct: 33.3 },
      { locale: 'pl', count: 1, sharePct: 16.7 },
    ]);
    // Strict desc-by-count: head element has the highest count.
    expect(result[0]!.count).toBeGreaterThanOrEqual(result[1]!.count);
  });
});
