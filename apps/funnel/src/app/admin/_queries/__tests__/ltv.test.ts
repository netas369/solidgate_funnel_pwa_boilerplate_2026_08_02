import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('averageCustomerLtvEur', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    process.env.ADMIN_FX_RATES = 'USD:0.9';
  });

  it('converts currency totals and divides by the distinct customer population', async () => {
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: [
            { currency: 'eur', net_amount_cents: 2000, customer_count: 2 },
            { currency: 'usd', net_amount_cents: 1000, customer_count: 2 },
          ],
          error: null,
        }),
      }),
    }));

    const { averageCustomerLtvEur } = await import('../revenue');
    await expect(averageCustomerLtvEur()).resolves.toEqual({
      averageNetLtvEurCents: 1450,
      customerCount: 2,
      totalNetRevenueEurCents: 2900,
      warning: null,
    });
  });

  it('fails visibly when the database aggregate is unavailable', async () => {
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'function does not exist' },
        }),
      }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { averageCustomerLtvEur } = await import('../revenue');
    const result = await averageCustomerLtvEur();

    expect(result.averageNetLtvEurCents).toBe(0);
    expect(result.customerCount).toBe(0);
    expect(result.warning).toContain('admin core migration');
  });

  it('marks LTV unavailable instead of applying a 1:1 missing FX rate', async () => {
    delete process.env.ADMIN_FX_RATES;
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: [{ currency: 'usd', net_amount_cents: 1000, customer_count: 1 }],
          error: null,
        }),
      }),
    }));

    const { averageCustomerLtvEur } = await import('../revenue');
    const result = await averageCustomerLtvEur();
    expect(result.averageNetLtvEurCents).toBe(0);
    expect(result.warning).toContain('Missing admin FX rate for USD');
  });
});
