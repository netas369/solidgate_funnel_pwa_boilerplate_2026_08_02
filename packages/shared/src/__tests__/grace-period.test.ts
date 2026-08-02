import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock admin client (mirrors entitlements.test.ts chainable proxy) ────────
const mockMaybeSingle = vi.fn();
const mockEqCalls: Array<[string, unknown]> = [];
const mockOrCalls: string[] = [];
const mockIsCalls: Array<[string, unknown]> = [];
const mockNotCalls: Array<[string, string, unknown]> = [];
const mockNeqCalls: Array<[string, unknown]> = [];
const mockOrderCalls: Array<[string, unknown]> = [];
const mockLimitCalls: number[] = [];

vi.mock('../supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table !== 'entitlements') throw new Error(`Unexpected table: ${table}`);
      const chainable: Record<string, unknown> = {};
      chainable.eq = vi.fn((col: string, val: unknown) => {
        mockEqCalls.push([col, val]);
        return chainable;
      });
      chainable.is = vi.fn((col: string, val: unknown) => {
        mockIsCalls.push([col, val]);
        return chainable;
      });
      chainable.or = vi.fn((filter: string) => {
        mockOrCalls.push(filter);
        return chainable;
      });
      chainable.not = vi.fn((col: string, op: string, val: unknown) => {
        mockNotCalls.push([col, op, val]);
        return chainable;
      });
      chainable.neq = vi.fn((col: string, val: unknown) => {
        mockNeqCalls.push([col, val]);
        return chainable;
      });
      chainable.order = vi.fn((col: string, opts: unknown) => {
        mockOrderCalls.push([col, opts]);
        return chainable;
      });
      chainable.limit = vi.fn((n: number) => {
        mockLimitCalls.push(n);
        return chainable;
      });
      chainable.maybeSingle = mockMaybeSingle;
      return {
        select: vi.fn(() => chainable),
      };
    }),
  })),
}));

import {
  getActiveGracePeriodSubscription,
  GRACE_EXCLUDED_SLUGS,
  GRACE_EXCLUDED_SLUG_PATTERNS,
} from '../grace-period';

describe('getActiveGracePeriodSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEqCalls.length = 0;
    mockOrCalls.length = 0;
    mockIsCalls.length = 0;
    mockNotCalls.length = 0;
    mockNeqCalls.length = 0;
    mockOrderCalls.length = 0;
    mockLimitCalls.length = 0;
  });

  it('returns null when no past_due+grace row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toBeNull();

    // Confirms the helper applied the past_due + grace filters
    expect(mockEqCalls).toContainEqual(['user_id', 'user-1']);
    expect(mockEqCalls).toContainEqual(['status', 'past_due']);
    expect(mockEqCalls).toContainEqual(['access_level', 'grace']);
  });

  it('returns subscription details for a past_due+grace row with future expires_at', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        solidgate_subscription_id: 'sub_grace_123',
        product_slug: 'LT_BRAND_000000_SUB',
        expires_at: future,
        granted_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toEqual({
      subscriptionId: 'sub_grace_123',
      productSlug: 'LT_BRAND_000000_SUB',
      productName: 'LT_BRAND_000000_SUB',
      expiresAt: future,
    });

    // Confirms revoked_at IS NULL is applied
    expect(mockIsCalls).toContainEqual(['revoked_at', null]);
    // Confirms ordering by most recent granted_at first + limit 1
    expect(mockOrderCalls[0]?.[0]).toBe('granted_at');
    expect(mockLimitCalls).toContain(1);
  });

  it('skips rows where revoked_at IS NOT NULL (helper must filter via .is)', async () => {
    // Helper passes revoked_at IS NULL filter to Supabase; we assert the
    // filter is applied. When the underlying row is revoked, the maybeSingle
    // call returns null because the row would be excluded server-side.
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toBeNull();
    expect(mockIsCalls).toContainEqual(['revoked_at', null]);
  });

  it("skips access_level='full' rows (helper filters access_level='grace')", async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toBeNull();
    // Critical: the helper MUST narrow to grace; 'full' rows would mean the
    // user is paying normally and should never see the banner.
    expect(mockEqCalls).toContainEqual(['access_level', 'grace']);
  });

  it('skips expired rows via .or(expires_at.is.null OR expires_at.gt.now)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await getActiveGracePeriodSubscription('user-1');

    // Verify the OR filter was applied and includes an expires_at.gt.<iso> clause
    const orFilter = mockOrCalls.find((f) => f.startsWith('expires_at.is.null'));
    expect(orFilter).toBeDefined();
    expect(orFilter).toMatch(/expires_at\.gt\.\d{4}-\d{2}-\d{2}T/);
  });

  it('excludes every add-on offering, by code pattern and by internal slug', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    await getActiveGracePeriodSubscription('user-1');

    // Assert against the exported constants, never re-typed literals, so this
    // test cannot drift when a new add-on is added to the exclusion list.
    expect(GRACE_EXCLUDED_SLUG_PATTERNS.length).toBeGreaterThan(0);
    expect(GRACE_EXCLUDED_SLUGS.length).toBeGreaterThan(0);
    for (const pattern of GRACE_EXCLUDED_SLUG_PATTERNS) {
      expect(mockNotCalls).toContainEqual(['product_slug', 'ilike', pattern]);
    }
    for (const slug of GRACE_EXCLUDED_SLUGS) {
      expect(mockNeqCalls).toContainEqual(['product_slug', slug]);
    }
    // …and nothing else is excluded — an over-broad filter would silently hide
    // the banner from main-subscription buyers, which is who it exists for.
    expect(mockNotCalls).toHaveLength(GRACE_EXCLUDED_SLUG_PATTERNS.length);
    expect(mockNeqCalls).toHaveLength(GRACE_EXCLUDED_SLUGS.length);
  });

  it('resolves a subscriber in grace by their PSP subscription id', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        solidgate_subscription_id: 'a1b2c3d4-0000-4000-8000-000000000001',
        product_slug: 'BRAND_000000_SUB',
        expires_at: future,
        granted_at: '2026-07-01T00:00:00Z',
      },
      error: null,
    });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.subscriptionId).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(result!.productSlug).toBe('BRAND_000000_SUB');
  });

  it('returns null when the matched row has no subscription id (defensive)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        solidgate_subscription_id: null,
        product_slug: 'LT_BRAND_000000_SUB',
        expires_at: null,
        granted_at: '2026-05-01T00:00:00Z',
      },
      error: null,
    });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toBeNull();
  });

  it('when multiple eligible rows exist, returns the one with most recent granted_at (via .order desc + limit 1)', async () => {
    // The .order('granted_at', { ascending: false }).limit(1).maybeSingle()
    // chain ensures only the newest row reaches the caller. We verify both the
    // ordering call and the returned row's shape.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        solidgate_subscription_id: 'sub_newest',
        product_slug: 'LV_BRAND_000000_SUB',
        expires_at: '2026-06-01T00:00:00Z',
        granted_at: '2026-05-10T00:00:00Z',
      },
      error: null,
    });

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result?.subscriptionId).toBe('sub_newest');
    // Contract: helper must call .order('granted_at', { ascending: false })
    expect(mockOrderCalls[0]?.[0]).toBe('granted_at');
    expect(mockOrderCalls[0]?.[1]).toEqual({ ascending: false });
    expect(mockLimitCalls).toContain(1);
  });

  it('fails closed (returns null) on DB error so a transient failure never surfaces a banner', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockRejectedValueOnce(new Error('connection refused'));

    const result = await getActiveGracePeriodSubscription('user-1');
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
