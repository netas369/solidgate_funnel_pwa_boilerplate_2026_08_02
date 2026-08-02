import { beforeEach, describe, expect, it, vi } from 'vitest';

// ../refetch-customers exposes refetchCustomers(range) which:
//   - throws Forbidden when the caller fails isAdminEmail() (defense-in-depth)
//   - returns the { orders } payload for a valid range

const VALID_RANGE = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-05-08T00:00:00.000Z',
};

describe('refetchCustomers server action', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-svc';
  });

  it('throws Forbidden when the caller is not an admin', async () => {
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
    vi.doMock('../../../_queries/customers', () => ({
      recentOrders: vi.fn().mockResolvedValue([]),
    }));

    const { refetchCustomers } = await import('../refetch-customers');
    await expect(refetchCustomers(VALID_RANGE)).rejects.toThrow('Forbidden');
  });

  it('returns {orders} for an admin caller', async () => {
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
    const orders = [
      {
        id: 'o1',
        createdAt: '2026-05-05T10:00:00Z',
        email: 'a@example.com',
        locale: 'en',
        productName: 'BRAND_000000_SUB',
        status: 'active',
        amountCents: 2900,
        currency: 'eur',
        subscriptionId: 'sub_1',
        isSubscription: true,
      },
    ];
    vi.doMock('../../../_queries/customers', () => ({
      recentOrders: vi.fn().mockResolvedValue(orders),
    }));

    const { refetchCustomers } = await import('../refetch-customers');
    const result = await refetchCustomers(VALID_RANGE);
    expect(result).toEqual({ orders });
  });
});
