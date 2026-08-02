import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE ON DEAD-ROUTE STATUS:
// GET /api/orders/lifetime-poll queries `orders` for product_slug ===
// SOLIDGATE_PRODUCT_CODES.lifetime. No current writer (grant, OTO routes,
// webhook) ever persists that slug — the live lifetime OTO is `oto1_lifetime`
// with company-code slugs like EN_BRANDLIFETIME_000000_SUB. In practice this
// route will always return { found: false }. These tests assert the route's
// own contract as written; the dead-route observation is reported separately.

// ─── Supabase server mock ─────────────────────────────────────────────────────
// Route chain: from('orders').select(...).eq().eq().eq().order().limit().maybeSingle()
const mockGetUser = vi.fn();
const mockMaybeSingle = vi.fn();
const mockLimit = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockEqStatus = vi.fn(() => ({ order: mockOrder }));
const mockEqProduct = vi.fn(() => ({ eq: mockEqStatus }));
const mockEqUser = vi.fn(() => ({ eq: mockEqProduct }));
const mockEqEnvironment = vi.fn(() => ({ eq: mockEqUser }));
const mockSelect = vi.fn(() => ({ eq: mockEqEnvironment }));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: vi.fn(() => ({ select: mockSelect })),
  })),
}));

async function getRoute() {
  const { GET } = await import('../route');
  return GET();
}

describe('GET /api/orders/lifetime-poll', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetUser.mockReset();
    mockMaybeSingle.mockReset();
    mockSelect.mockClear();
    mockEqEnvironment.mockClear();
    mockEqUser.mockClear();
    mockEqProduct.mockClear();
    mockEqStatus.mockClear();
  });

  it('returns 401 when the user is not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await getRoute();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'Unauthorised' });
  });

  it('returns { found: false } when no completed lifetime row exists', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await getRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ found: false });
  });

  it('queries orders scoped to the user, the lifetime slug, and completed status', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-42' } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await getRoute();

    expect(mockSelect).toHaveBeenCalledWith(
      'id, product_name, product_slug, amount_cents, currency',
    );
    expect(mockEqEnvironment).toHaveBeenCalledWith('payment_environment', 'sandbox');
    expect(mockEqUser).toHaveBeenCalledWith('user_id', 'user-42');
    expect(mockEqProduct).toHaveBeenCalledWith('product_slug', 'BRANDLIFETIME_000000_SUB');
    expect(mockEqStatus).toHaveBeenCalledWith('status', 'completed');
  });

  it('returns { found: true, order } including product_slug when the row exists', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'db-order-abc',
        product_name: 'Demo Lifetime Access',
        product_slug: 'BRANDLIFETIME_000000_SUB',
        amount_cents: 9900,
        currency: 'eur',
      },
      error: null,
    });

    const res = await getRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      found: true,
      order: {
        id: 'db-order-abc',
        product_name: 'Demo Lifetime Access',
        product_slug: 'BRANDLIFETIME_000000_SUB',
        amount_cents: 9900,
        currency: 'eur',
      },
    });
  });

  it('falls back to the lifetime product code when the row has a null product_slug', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'db-order-xyz',
        product_name: 'Demo Lifetime Access',
        product_slug: null,
        amount_cents: 9900,
        currency: 'eur',
      },
      error: null,
    });

    const res = await getRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      found: true,
      order: {
        id: 'db-order-xyz',
        product_name: 'Demo Lifetime Access',
        product_slug: 'BRANDLIFETIME_000000_SUB',
        amount_cents: 9900,
        currency: 'eur',
      },
    });
  });

  it('returns 500 when the DB query fails', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db error' } });

    const res = await getRoute();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'Query failed' });
  });
});
