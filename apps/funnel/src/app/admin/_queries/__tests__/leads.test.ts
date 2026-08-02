import { beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 04): ../leads exposes countLeadsInRange(range) -> number,
// filtering funnel_events by event_type='lead_captured'.

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

describe('leads query (GREEN — Plan 04 implementation)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it("countLeadsInRange filters by event_type='lead_captured'", async () => {
    const eq = vi.fn().mockReturnThis();
    const builder = {
      select: vi.fn(() => ({
        eq,
        gte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({ count: 7, error: null }),
      })),
    };
    // The chained `select(...).eq(...).gte(...).lt(...)` returns the count
    // at the end of the lt() promise; we wire eq → returns object with gte/lt.
    const selectMockImpl = (_cols: string, _opts: { count?: string; head?: boolean }) => {
      const chain = {
        eq: vi.fn((col: string, val: unknown) => {
          expect(col).toBe('event_type');
          expect(val).toBe('lead_captured');
          return {
            gte: vi.fn().mockReturnThis(),
            lt: vi.fn().mockResolvedValue({ count: 7, error: null }),
          };
        }),
      };
      return chain;
    };
    builder.select = vi.fn(selectMockImpl) as unknown as typeof builder.select;
    // Silence the unused-vars on `eq`
    void eq;

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          expect(table).toBe('funnel_events');
          return builder;
        }),
      }),
    }));

    const { countLeadsInRange } = await import('../leads');
    const result = await countLeadsInRange(RANGE);
    expect(result).toBe(7);
    expect(builder.select).toHaveBeenCalledWith('*', { count: 'exact', head: true });
  });
});
