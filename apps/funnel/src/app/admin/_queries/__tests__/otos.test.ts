import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_ID_TO_CODE } from '@repo/shared/solidgate/catalog';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@repo/shared/supabase/admin', () => ({ getSupabaseAdminClient: () => ({ rpc }) }));
const RANGE={from:'2026-05-01T00:00:00Z',to:'2026-05-08T00:00:00Z'};
beforeEach(()=>{vi.resetModules();rpc.mockReset();});
describe('OTO monetary aggregates',()=>{
  it('keeps sibling offers separate and excludes renewals from initial-payment revenue',async()=>{
    const offers=Object.entries(PRODUCT_ID_TO_CODE).filter(([key])=>key.startsWith('oto'));
    rpc.mockImplementation(async(name:string)=>({error:null,data:name==='get_solidgate_purchase_counts'?
      offers.map(([,code])=>({product_slug:code,count:1})):{legacy_movements:0,rows:offers.flatMap(([,code])=>[
        {day:'2026-05-02',currency:'eur',product_slug:code,billing_type:'initial',captured_cents:1000,refunded_cents:200,chargeback_cents:0,net_cents:800,payments:1},
        {day:'2026-05-02',currency:'eur',product_slug:code,billing_type:'renewal',captured_cents:5000,refunded_cents:0,chargeback_cents:0,net_cents:5000,payments:1},
      ])}}));
    const {otoCountsPerOffer}=await import('../otos');
    const data=await otoCountsPerOffer(RANGE);
    expect(data).toHaveLength(offers.length);
    expect(new Set(data.map(row=>row.pattern)).size).toBe(offers.length);
    for(const row of data){expect(row.count).toBe(1);expect(row.amountEurCents).toBe(800);}
  });
});
