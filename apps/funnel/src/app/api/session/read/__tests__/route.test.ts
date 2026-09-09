import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockVerifyPaymentCookie = vi.fn();
const mockGetCookie = vi.fn();
const mockGetUser = vi.fn();
const mockSelectSingle = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      get: mockGetCookie,
    }),
  ),
}));

vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
  verifyPaymentCookie: mockVerifyPaymentCookie,
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mockSelectSingle,
        })),
      })),
    })),
  })),
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: {
        getUser: mockGetUser,
      },
    }),
  ),
}));

async function getRoute(sessionId?: string) {
  const { GET } = await import('../route');
  const url = sessionId
    ? `http://localhost/api/session/read?sessionId=${sessionId}`
    : 'http://localhost/api/session/read';
  return GET(new Request(url));
}

describe('GET /api/session/read', () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyPaymentCookie.mockReset();
    mockGetCookie.mockReset();
    mockGetUser.mockReset();
    mockSelectSingle.mockReset();
  });

  it('returns 400 for missing sessionId query param', async () => {
    const response = await getRoute();

    expect(response.status).toBe(400);
  });

  it('returns 404 when session does not exist', async () => {
    mockSelectSingle.mockResolvedValue({ data: null });
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await getRoute('sid');

    expect(response.status).toBe(404);
  });

  it('returns session data for authenticated owner', async () => {
    mockSelectSingle.mockResolvedValue({
      data: {
        id: 'sid',
        user_id: 'uid-1',
        quiz_answers: {},
        result_segment: 'weight_loss',
      },
    });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } } });

    const response = await getRoute('sid');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: 'sid' });
  });

  it('returns session data for valid payment cookie', async () => {
    mockSelectSingle.mockResolvedValue({
      data: { id: 'sid', user_id: null, quiz_answers: {} },
    });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockGetCookie.mockReturnValue({ value: 'signed-cookie' });
    mockVerifyPaymentCookie.mockResolvedValue({ paymentIntentId: 'pi_1', sessionId: 'sid' });

    const response = await getRoute('sid');

    expect(response.status).toBe(200);
  });

  it('returns 403 for authenticated non-owner without cookie', async () => {
    mockSelectSingle.mockResolvedValue({
      data: { id: 'sid', user_id: 'uid-other' },
    });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-1' } } });
    mockGetCookie.mockReturnValue(undefined);

    const response = await getRoute('sid');

    expect(response.status).toBe(403);
  });

  it('returns 401 when cookie sessionId does not match', async () => {
    mockSelectSingle.mockResolvedValue({
      data: { id: 'sid', user_id: null },
    });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockGetCookie.mockReturnValue({ value: 'cookie' });
    mockVerifyPaymentCookie.mockResolvedValue({ paymentIntentId: 'pi_1', sessionId: 'different-sid' });

    const response = await getRoute('sid');

    expect(response.status).toBe(401);
  });

  it('returns 401 with no auth and no cookie', async () => {
    mockSelectSingle.mockResolvedValue({
      data: { id: 'sid', user_id: null },
    });
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockGetCookie.mockReturnValue(undefined);

    const response = await getRoute('sid');

    expect(response.status).toBe(401);
  });

  // ─── Coverage: maybeEnrichWithSubscription (lines 60-70) ────────────────────
  describe('include=subscription enrichment', () => {
    // Helper that passes include=subscription query param
    async function getRouteWithInclude(sessionId: string) {
      const { GET } = await import('../route');
      const url = `http://localhost/api/session/read?sessionId=${sessionId}&include=subscription`;
      return GET(new Request(url));
    }

    it('enriches session with subscription_plan_name when active subscription order exists', async () => {
      // The admin client mock needs to handle two calls:
      // 1. sessions.select().eq().single()  -  initial session lookup
      // 2. orders.select().eq().eq().in().not().limit().maybeSingle()  -  subscription lookup
      //
      // Since the mock uses a single selectSingle fn, we need to make it work for the first call.
      // For the second call (orders), we need a separate mock chain.
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: { product_name: 'Demo Monthly Plan' },
      });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockNot = vi.fn(() => ({ limit: mockLimit }));
      const mockIn = vi.fn(() => ({ not: mockNot }));
      const ordersFilters = { eq: vi.fn(), in: mockIn };
      ordersFilters.eq.mockReturnValue(ordersFilters);

      // Override admin client mock for this test
      const adminMod = await import('@repo/shared/supabase/admin');
      (adminMod.getSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'orders') {
            return {
              select: vi.fn(() => ordersFilters),
            };
          }
          // sessions table
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'sid-sub',
                    user_id: 'uid-sub',
                    current_step_id: null,
                    quiz_answers: {},
                    email: null,
                    result_segment: 'weight_loss',
                  },
                }),
              })),
            })),
          };
        }),
      });
      mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-sub' } } });

      const response = await getRouteWithInclude('sid-sub');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.subscription_plan_name).toBe('Demo Monthly Plan');
      expect(mockNot).toHaveBeenCalledWith('solidgate_subscription_id', 'is', null);
    });

    it('returns subscription_plan_name as null when no active subscription order', async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null });
      const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockNot = vi.fn(() => ({ limit: mockLimit }));
      const mockIn = vi.fn(() => ({ not: mockNot }));
      const ordersFilters = { eq: vi.fn(), in: mockIn };
      ordersFilters.eq.mockReturnValue(ordersFilters);

      const adminMod = await import('@repo/shared/supabase/admin');
      (adminMod.getSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn((table: string) => {
          if (table === 'orders') {
            return {
              select: vi.fn(() => ordersFilters),
            };
          }
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'sid-nosub',
                    user_id: 'uid-nosub',
                    current_step_id: null,
                    quiz_answers: {},
                    email: null,
                    result_segment: null,
                  },
                }),
              })),
            })),
          };
        }),
      });
      mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-nosub' } } });

      const response = await getRouteWithInclude('sid-nosub');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.subscription_plan_name).toBeNull();
    });

    it('does not enrich when include param is not "subscription"', async () => {
      // Restore admin client mock to default (previous tests override it)
      const adminMod = await import('@repo/shared/supabase/admin');
      (adminMod.getSupabaseAdminClient as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 'sid-noinc',
                  user_id: 'uid-noinc',
                  current_step_id: null,
                  quiz_answers: {},
                  email: null,
                  result_segment: null,
                },
              }),
            })),
          })),
        })),
      });
      mockGetUser.mockResolvedValue({ data: { user: { id: 'uid-noinc' } } });

      const { GET } = await import('../route');
      const url = 'http://localhost/api/session/read?sessionId=sid-noinc&include=other';
      const response = await GET(new Request(url));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.subscription_plan_name).toBeUndefined();
    });
  });
});
