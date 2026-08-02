import { beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 04): ../revenue exposes
//   grossRevenueInEurInRange  (Pitfall 4: status IN (completed,active) + amount_cents > 0)
//   revenueByCurrencyInRange
//   renewalRevenueInEur       (D-20)
//   revenueTimeSeriesInEur

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

interface OrdersChainSpy {
  eqArgs: Array<[string, unknown]>;
  inArgs: Array<[string, unknown]>;
  gtArgs: Array<[string, unknown]>;
  gteArgs: Array<[string, unknown]>;
  ltArgs: Array<[string, unknown]>;
}

function makeOrdersBuilder(rows: Array<Record<string, unknown>>) {
  const spy: OrdersChainSpy = {
    eqArgs: [],
    inArgs: [],
    gtArgs: [],
    gteArgs: [],
    ltArgs: [],
  };
  const builder = {
    select: vi.fn(() => ({
      eq: vi.fn((col: string, val: unknown) => {
        spy.eqArgs.push([col, val]);
        return {
          in: vi.fn((inCol: string, inVal: unknown) => {
            spy.inArgs.push([inCol, inVal]);
            return {
              gt: vi.fn((c: string, v: unknown) => {
                spy.gtArgs.push([c, v]);
                return {
                  gte: vi.fn((c2: string, v2: unknown) => {
                    spy.gteArgs.push([c2, v2]);
                    return {
                      lt: vi.fn((c3: string, v3: unknown) => {
                        spy.ltArgs.push([c3, v3]);
                        return Promise.resolve({ data: rows, error: null });
                      }),
                    };
                  }),
                };
              }),
            };
          }),
        };
      }),
    })),
  };
  return { builder, spy };
}

function makeRenewalsBuilder(rows: Array<Record<string, unknown>>) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ data: rows, error: null }),
    })),
  };
}

describe('revenue query (GREEN — Plan 04 implementation)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    process.env.ADMIN_FX_RATES = 'USD:0.92';
  });

  it('grossRevenueInEurInRange counts collected money in any lifecycle state, never zero-amount rows', async () => {
    // Mock supabase returns ONLY rows that the implementation's filters allow
    // through. Collected money is independent of the CURRENT status — a paid
    // trial settles its intro fee at signup (auth_settle), and past_due /
    // canceled subs keep the money they took — so only pending/failed (never
    // charged) and refunded (gave it back) stay out, plus every zero-amount
    // row via .gt('amount_cents', 0).
    const orders = makeOrdersBuilder([
      { amount_cents: 600, currency: 'eur' },
      { amount_cents: 1100, currency: 'eur' },
    ]);

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'orders') return orders.builder;
          if (table === 'renewal_events') return makeRenewalsBuilder([]);
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { grossRevenueInEurInRange } = await import('../revenue');
    const total = await grossRevenueInEurInRange(RANGE);

    expect(total).toBe(1700); // 600 + 1100 (EUR pass-through)
    // Query-shape assertions:
    expect(orders.spy.eqArgs).toEqual([
      ['payment_environment', 'production'],
    ]);
    expect(orders.spy.inArgs).toEqual([
      ['status', ['completed', 'active', 'trialing', 'past_due', 'canceled']],
    ]);
    expect(orders.spy.gtArgs).toEqual([['amount_cents', 0]]);
    expect(orders.spy.gteArgs).toEqual([['created_at', RANGE.from]]);
    expect(orders.spy.ltArgs).toEqual([['created_at', RANGE.to]]);
  });

  it('converts non-EUR amounts via ADMIN_FX_RATES', async () => {
    const orders = makeOrdersBuilder([
      { amount_cents: 1000, currency: 'usd' }, // -> 920 EUR
      { amount_cents: 500, currency: 'eur' }, // -> 500 EUR pass-through
    ]);

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'orders') return orders.builder;
          if (table === 'renewal_events') return makeRenewalsBuilder([]);
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { grossRevenueInEurInRange } = await import('../revenue');
    const total = await grossRevenueInEurInRange(RANGE);
    expect(total).toBe(920 + 500);
  });
});
