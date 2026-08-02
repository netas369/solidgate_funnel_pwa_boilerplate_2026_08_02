import { beforeEach, describe, expect, it, vi } from 'vitest';

// ../customers exposes recentOrders(range) → newest-first CustomerOrderRow[],
// resolving email/locale from the embedded session and flagging subscriptions
// on the Solidgate subscription id.

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

describe('customers query', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it('recentOrders maps embedded session and flags subscriptions on either PSP', async () => {
    const rows = [
      {
        id: 'o1',
        created_at: '2026-05-05T10:00:00Z',
        status: 'active',
        product_name: 'BRAND_000000_SUB',
        amount_cents: 2900,
        currency: 'eur',
        solidgate_subscription_id: 'sg-sub-1',
        sessions: { email: 'a@example.com', locale: 'en' },
      },
      {
        id: 'o2',
        created_at: '2026-05-04T10:00:00Z',
        status: 'completed',
        product_name: 'BRANDBUNDLE_000000_PDF',
        amount_cents: 1900,
        currency: 'usd',
        solidgate_subscription_id: null,
        sessions: null,
      },
      // A second Solidgate subscription row.
      {
        id: 'o3',
        created_at: '2026-05-03T10:00:00Z',
        status: 'trialing',
        product_name: 'BRAND_000000_SUB',
        amount_cents: 900,
        currency: 'usd',
        solidgate_subscription_id: 'sg-sub-9',
        sessions: { email: 'b@example.com', locale: 'cs' },
      },
    ];
    const eq = vi.fn();
    const neq = vi.fn();
    const builder = {
      select: vi.fn(() => ({
        eq: eq.mockReturnThis(),
        neq: neq.mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
      })),
    };
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          expect(table).toBe('orders');
          return builder;
        }),
      }),
    }));

    const { recentOrders } = await import('../customers');
    const result = await recentOrders(RANGE);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      id: 'o1',
      createdAt: '2026-05-05T10:00:00Z',
      email: 'a@example.com',
      locale: 'en',
      productName: 'BRAND_000000_SUB',
      status: 'active',
      amountCents: 2900,
      currency: 'eur',
      subscriptionId: 'sg-sub-1',
      isSubscription: true,
    });
    // Order with no session → email/locale null, not a subscription.
    expect(result[1]!.email).toBeNull();
    expect(result[1]!.locale).toBeNull();
    expect(result[1]!.isSubscription).toBe(false);
    expect(result[1]!.subscriptionId).toBeNull();
    // Solidgate subscription id fills the subscription field.
    expect(result[2]!.subscriptionId).toBe('sg-sub-9');
    expect(result[2]!.isSubscription).toBe(true);

    // Solidgate pre-writes 'pending' rows at checkout open; the tab must
    // filter them out at the query layer.
    expect(eq).toHaveBeenCalledWith('payment_environment', 'production');
    expect(neq).toHaveBeenCalledWith('status', 'pending');
  });
});
