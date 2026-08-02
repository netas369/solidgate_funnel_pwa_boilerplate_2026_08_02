import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRICE_MAP } from '@repo/shared/price-map';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';

// ../subscriptions exposes
//   trialStartsInRange, paidConversionsCohort (7d gate),
//   paidConversionsRolling (updated_at), recurringOtoSnapshot (split-query).
// Order queries match the main offering on orders.product_slug, and the cohort
// joins renewal_events through orders.solidgate_subscription_id.

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

// ─── Helpers: mock-builders that mirror the chains the implementation uses ──

/** orders trials select chain used by paidConversionsCohort step 1. */
function makeTrialsBuilder(rows: Array<Record<string, unknown>>) {
  const or = vi.fn();
  return {
    select: vi.fn(() => ({
      eq: vi.fn().mockReturnThis(),
      or: or.mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ data: rows, error: null }),
    })),
    __or: or,
  };
}

/**
 * renewal_events batched lookup used inside paidConversionsCohort:
 * .select(...).in(column, ids), resolving the matching rows.
 */
function makeRenewalLookup(rowsByColumn: Record<string, Array<Record<string, unknown>>>) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        in: vi.fn((column: string) =>
          Promise.resolve({ data: rowsByColumn[column] ?? [], error: null }),
        ),
      })),
    })),
  };
}

describe('subscriptions query', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    process.env.ADMIN_FX_RATES = '';
  });

  it('paidConversionsCohort: cohort 7d gate excludes trials whose first paid charge is <7d after trial start', async () => {
    const trialStart = '2026-05-01T00:00:00Z';
    const trials = [
      // sub1: active + first paid 8 days later → CONVERTED.
      { solidgate_subscription_id: 'sub1', created_at: trialStart, status: 'active' },
      // sub2: active + first paid 6 days later → NOT converted (under gate).
      { solidgate_subscription_id: 'sub2', created_at: trialStart, status: 'active' },
    ];
    const renewals = makeRenewalLookup({
      solidgate_subscription_id: [
        { solidgate_subscription_id: 'sub1', created_at: '2026-05-09T00:00:00Z' }, // +8 days
        { solidgate_subscription_id: 'sub2', created_at: '2026-05-07T00:00:00Z' }, // +6 days
      ],
    });

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'orders') return makeTrialsBuilder(trials);
          if (table === 'renewal_events') return renewals;
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { paidConversionsCohort } = await import('../subscriptions');
    const result = await paidConversionsCohort(RANGE);
    expect(result.cohortSize).toBe(2);
    expect(result.converted).toBe(1);
    expect(result.ratePct).toBe(50);
  });

  it('paidConversionsCohort: a trial converts through solidgate_subscription_id', async () => {
    const trialStart = '2026-05-01T00:00:00Z';
    const trials = [
      // Converted, later hit dunning — still converted.
      { solidgate_subscription_id: 'sg-1', created_at: trialStart, status: 'past_due' },
      // Active, no renewal yet → not converted.
      { solidgate_subscription_id: 'sg-2', created_at: trialStart, status: 'active' },
      // Converted inside the window.
      { solidgate_subscription_id: 'sg-3', created_at: trialStart, status: 'active' },
    ];
    const renewals = makeRenewalLookup({
      solidgate_subscription_id: [
        { solidgate_subscription_id: 'sg-1', created_at: '2026-05-10T00:00:00Z' }, // +9 days
        { solidgate_subscription_id: 'sg-3', created_at: '2026-05-09T00:00:00Z' }, // +8 days
      ],
    });

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'orders') return makeTrialsBuilder(trials);
          if (table === 'renewal_events') return renewals;
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { paidConversionsCohort } = await import('../subscriptions');
    const result = await paidConversionsCohort(RANGE);
    expect(result.cohortSize).toBe(3);
    expect(result.converted).toBe(2); // sg-1 (past_due but paid) + sg-3
  });

  it("paidConversionsCohort: counts only paid-state orders with ≥1 renewal_events row", async () => {
    const trialStart = '2026-05-01T00:00:00Z';
    const trials = [
      // active + has renewal ≥7d → converts.
      { solidgate_subscription_id: 'sub1', created_at: trialStart, status: 'active' },
      // active but NO renewal_events row → not converted (renewal requirement).
      { solidgate_subscription_id: 'sub2', created_at: trialStart, status: 'active' },
      // status=canceled — never enters the converted check at all.
      { solidgate_subscription_id: 'sub3', created_at: trialStart, status: 'canceled' },
      // status=trialing — never enters the converted check.
      { solidgate_subscription_id: 'sub4', created_at: trialStart, status: 'trialing' },
    ];
    const renewals = makeRenewalLookup({
      solidgate_subscription_id: [
        { solidgate_subscription_id: 'sub1', created_at: '2026-05-09T00:00:00Z' }, // +8 days
      ],
    });

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'orders') return makeTrialsBuilder(trials);
          if (table === 'renewal_events') return renewals;
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { paidConversionsCohort } = await import('../subscriptions');
    const result = await paidConversionsCohort(RANGE);
    expect(result.cohortSize).toBe(4);
    expect(result.converted).toBe(1); // only sub1 (active + has renewal + ≥7d gap)
    expect(result.ratePct).toBe(25); // 1/4 * 100 = 25%
  });

  it('recurringOtoSnapshot returns snapshot shape without throwing', async () => {
    // Entitlements: 2 rows. One non-expired (expires_at null), one expired
    // (expires_at in the past). TS-side filter must drop the expired row.
    const ents = [
      { user_id: 'u1', expires_at: null, product_slug: 'oto2_addon_weekly' },
      {
        user_id: 'u2',
        // Expired well before now — TS filter must reject this row.
        expires_at: '2020-01-01T00:00:00Z',
        product_slug: 'oto2_addon_weekly',
      },
    ];
    const renewals = [
      { amount_cents: 1000, currency: 'eur', product_key: SOLIDGATE_PRODUCT_CODES.addon },
      // Renewal for a different offering — TS filter must reject this row.
      { amount_cents: 9999, currency: 'eur', product_key: SOLIDGATE_PRODUCT_CODES.bundleAll },
    ];

    function makeOrBuilder(data: Array<Record<string, unknown>>) {
      const orFilter = vi.fn(() => Promise.resolve({ data, error: null }));
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
          is: vi.fn(() => ({ or: orFilter })),
        })),
        __orFilter: orFilter,
      };
    }

    function makeRenewalsBuilder(data: Array<Record<string, unknown>>) {
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lt: vi.fn().mockResolvedValue({ data, error: null }),
        })),
      };
    }

    const entBuilder = makeOrBuilder(ents);
    const renBuilder = makeRenewalsBuilder(renewals);

    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          if (table === 'entitlements') return entBuilder;
          if (table === 'renewal_events') return renBuilder;
          throw new Error(`unexpected from(${table})`);
        }),
      }),
    }));

    const { recurringOtoSnapshot } = await import('../subscriptions');
    const result = await recurringOtoSnapshot(RANGE);

    // Shape: exactly four documented keys.
    expect(Object.keys(result).sort()).toEqual(
      [
        'activeCount',
        'estimatedMrrEurCents',
        'renewalRevenueEurCents',
        'sample',
      ].sort(),
    );
    expect(typeof result.activeCount).toBe('number');
    expect(typeof result.estimatedMrrEurCents).toBe('number');
    expect(typeof result.renewalRevenueEurCents).toBe('number');
    expect(Array.isArray(result.sample)).toBe(true);

    // Intersection: only u1 is non-expired → activeCount === 1.
    expect(result.activeCount).toBe(1);
    // The recurring OTO bills WEEKLY: MRR per active sub is the EN weekly price
    // annualised to a month.
    const weeklyCents = PRICE_MAP.oto2_addon_weekly.en.amountCents;
    expect(result.estimatedMrrEurCents).toBe(Math.round((weeklyCents * 52) / 12));
    // Renewal revenue filtered to the recurring OTO only → 1000 (EUR pass-through).
    expect(result.renewalRevenueEurCents).toBe(1000);

    // Contract: the .or() must have been called with a STATIC pattern
    // containing only product_slug clauses (no timestamp text).
    const orCalls = entBuilder.__orFilter.mock.calls as unknown as string[][];
    expect(orCalls.length).toBeGreaterThanOrEqual(1);
    const orArg = orCalls[0]![0]!;
    expect(orArg).toContain('product_slug');
    // No ISO-8601 timestamp anywhere in the filter string.
    expect(orArg).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('subscriptionStatusBreakdown groups plan-sub orders by current status and drops never-a-sub rows', async () => {
    const orders = [
      { status: 'trialing' },
      { status: 'trialing' },
      { status: 'active' },
      { status: 'active' },
      { status: 'active' },
      { status: 'past_due' },
      { status: 'canceled' },
      { status: 'refunded' }, // → other bucket
    ];
    const or = vi.fn();
    const not = vi.fn();
    const builder = {
      select: vi.fn(() => ({
        eq: vi.fn().mockReturnThis(),
        or: or.mockReturnThis(),
        not: not.mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({ data: orders, error: null }),
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

    const { subscriptionStatusBreakdown } = await import('../subscriptions');
    const result = await subscriptionStatusBreakdown(RANGE);
    expect(result).toEqual({
      trialing: 2,
      active: 3,
      pastDue: 1,
      canceled: 1,
      other: 1,
      total: 8,
    });
    // Main-plan matcher: the catalog offering code on orders.product_slug.
    const orArg = String(or.mock.calls[0]?.[0] ?? '');
    expect(orArg).toContain(`product_slug.eq.${SOLIDGATE_PRODUCT_CODES.main}`);
    // Solidgate pre-writes 'pending' rows and declines stay 'failed' — a
    // status view must exclude both at the query layer.
    expect(not).toHaveBeenCalledWith('status', 'in', '("pending","failed")');
  });

  it('subscriptionVariantBreakdown splits plan subs by the tier inside the Solidgate order id', async () => {
    const SID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const orders = [
      { solidgate_order_id: `${SID}:trial1:1` },
      { solidgate_order_id: `${SID}:trial4:2` },
      { solidgate_order_id: `${SID}:special_1eur:1` },
      { solidgate_order_id: `${SID}:special_free:1` },
      { solidgate_order_id: `${SID}:special_free:3` },
      { solidgate_order_id: null }, // no parseable order id → legacy
    ];
    const builder = {
      select: vi.fn(() => ({
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lt: vi.fn().mockResolvedValue({ data: orders, error: null }),
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

    const { subscriptionVariantBreakdown } = await import('../subscriptions');
    const result = await subscriptionVariantBreakdown(RANGE);
    expect(result).toEqual({
      main: 2,
      special1eur: 1,
      specialFree: 2,
      legacy: 1,
      total: 6,
    });
  });
});
