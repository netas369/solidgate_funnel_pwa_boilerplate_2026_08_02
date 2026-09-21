import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@repo/shared/supabase/admin', () => ({ getSupabaseAdminClient: () => ({ rpc }) }));
const RANGE = {from:'2026-05-01T00:00:00Z',to:'2026-05-08T00:00:00Z'};
function report() { return {
  cohort_size:4,converted:3,rolling_numerator:2,rolling_denominator:5,legacy_starts:1,
  status:{trialing:1,active:1,pastDue:0,canceled:1,other:1,total:4},
  variants:{main:4,special1eur:0,specialFree:0,legacy:0,total:4},
  addon:{active_count:2,unknown_price_count:0,monthly_amounts:[{currency:'eur',amount_cents:5000},{currency:'usd',amount_cents:1000}],sample:[]},
}; }
beforeEach(() => {vi.resetModules();vi.stubEnv('ADMIN_FX_RATES','USD:0.92');rpc.mockReset();});
afterEach(() => vi.unstubAllEnvs());
describe('subscription reporting', () => {
  it('keeps converted canceled/refunded customers and uses actual observed addon amounts', async () => {
    rpc.mockImplementation(async (name:string) => ({error:null,data:name==='get_solidgate_subscription_report' ? report() : {legacy_movements:0,rows:[{
      day:'2026-05-04',currency:'eur',billing_type:'renewal',product_slug:SOLIDGATE_PRODUCT_CODES.addon,
      captured_cents:500,refunded_cents:100,chargeback_cents:0,net_cents:400,payments:1,
    }]}}));
    const { subscriptionsSummaryInRange } = await import('../subscriptions');
    const summary = await subscriptionsSummaryInRange(RANGE);
    expect(summary.cohort).toEqual({cohortSize:4,converted:3,ratePct:75});
    expect(summary.rolling).toEqual({numerator:2,denominator:5,ratePct:40});
    expect(summary.recurringOto).toMatchObject({estimatedMrrEurCents:5920,renewalRevenueEurCents:400,activeCount:2});
    expect(summary.legacyStarts).toBe(1);
  });
  it('does not manufacture MRR from a template price when a paid period is unknown', async () => {
    const data=report();data.addon.unknown_price_count=1;
    rpc.mockImplementation(async(name:string)=>({error:null,data:name==='get_solidgate_subscription_report'?data:{legacy_movements:0,rows:[]}}));
    const { recurringOtoSnapshot } = await import('../subscriptions');
    expect((await recurringOtoSnapshot(RANGE)).estimatedMrrEurCents).toBeNull();
  });
  it('surfaces failed reports instead of showing zero subscribers', async () => {
    rpc.mockResolvedValue({error:{message:'offline'},data:null});
    const { paidConversionsCohort } = await import('../subscriptions');
    await expect(paidConversionsCohort(RANGE)).rejects.toThrow('offline');
  });
});
