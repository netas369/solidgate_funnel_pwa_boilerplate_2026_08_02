import { beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 04): ../sessions exposes
//   countSessionsInRange(range) -> number
//   sessionsTimeSeries(range)   -> Array<{date, count}>

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

interface SelectCall {
  cols: string;
  opts?: { count?: 'exact'; head?: boolean };
}

function makeCountBuilder(count: number) {
  return {
    select: vi.fn((_cols: string, _opts?: SelectCall['opts']) => ({
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ count, error: null }),
    })),
  };
}

function makeRowsBuilder(rows: Array<{ created_at: string }>) {
  return {
    select: vi.fn(() => ({
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: rows, error: null }),
    })),
  };
}

describe('sessions query (GREEN — Plan 04 implementation)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it('countSessionsInRange returns count from supabase mock', async () => {
    const builder = makeCountBuilder(42);
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          expect(table).toBe('sessions');
          return builder;
        }),
      }),
    }));
    const { countSessionsInRange } = await import('../sessions');
    const result = await countSessionsInRange(RANGE);
    expect(result).toBe(42);
    expect(builder.select).toHaveBeenCalledWith('*', { count: 'exact', head: true });
  });

  it('sessionsTimeSeries buckets results by UTC day', async () => {
    const builder = makeRowsBuilder([
      { created_at: '2026-05-01T10:00:00Z' },
      { created_at: '2026-05-01T22:00:00Z' },
      { created_at: '2026-05-02T05:00:00Z' },
    ]);
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn(() => builder),
      }),
    }));
    const { sessionsTimeSeries } = await import('../sessions');
    const result = await sessionsTimeSeries(RANGE);
    expect(result).toEqual([
      { date: '2026-05-01', count: 2 },
      { date: '2026-05-02', count: 1 },
    ]);
  });
});
