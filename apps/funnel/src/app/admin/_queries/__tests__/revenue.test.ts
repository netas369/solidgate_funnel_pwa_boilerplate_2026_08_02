import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@repo/shared/supabase/admin', () => ({ getSupabaseAdminClient: () => ({ rpc }) }));
const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };
function row(values: Record<string, unknown> = {}) {
  return { day: '2026-05-02', currency: 'eur', billing_type: 'initial', product_slug: 'MAIN',
    captured_cents: 1000, refunded_cents: 0, chargeback_cents: 0, net_cents: 1000, payments: 1, ...values };
}
beforeEach(() => { vi.resetModules(); rpc.mockReset(); vi.stubEnv('ADMIN_FX_RATES', 'USD:0.92'); });
afterEach(() => vi.unstubAllEnvs());
describe('movement-based revenue', () => {
  it('includes renewals in the total and records later reversals on their event dates', async () => {
    rpc.mockResolvedValue({ error: null, data: { legacy_movements: 0, rows: [row(), row({billing_type:'renewal',captured_cents:5900,net_cents:5900}), row({day:'2026-05-03',captured_cents:0,refunded_cents:400,net_cents:-400,payments:0})] } });
    const { revenueSummaryInRange } = await import('../revenue');
    const report = await revenueSummaryInRange(RANGE);
    expect(report).toMatchObject({totalEur:6500,grossEur:6900,refundsEur:400,oneTimeEur:600,renewalEur:5900});
    expect(report.timeSeries).toEqual([{date:'2026-05-02',value:6900},{date:'2026-05-03',value:-400}]);
  });
  it('preserves native money and suppresses partial EUR charts with missing FX', async () => {
    rpc.mockResolvedValue({ error: null, data: { legacy_movements: 2, rows: [row(),row({currency:'cad',net_cents:500,captured_cents:500})] } });
    const { revenueSummaryInRange } = await import('../revenue');
    const report = await revenueSummaryInRange(RANGE);
    expect(report.totalEur).toBeNull(); expect(report.timeSeries).toEqual([]);
    expect(report.byCurrency).toEqual({EUR:1000,CAD:500}); expect(report.missingFxCurrencies).toEqual(['CAD']);
    expect(report.legacyMovements).toBe(2);
  });
  it('aggregates minor units before conversion so tiny payments do not disappear', async () => {
    vi.stubEnv('ADMIN_FX_RATES', 'USD:0.4');
    rpc.mockResolvedValue({ error: null, data: { legacy_movements: 0, rows: [row({currency:'usd',net_cents:1}),row({currency:'usd',net_cents:1})] } });
    const { netRevenueInEurInRange } = await import('../revenue');
    expect(await netRevenueInEurInRange(RANGE)).toBe(1);
  });
  it('fails visibly on unavailable or unsafe monetary data', async () => {
    const { revenueSummaryInRange } = await import('../revenue');
    rpc.mockResolvedValue({ error: { message:'database unavailable' }, data:null });
    await expect(revenueSummaryInRange(RANGE)).rejects.toThrow('unavailable');
    rpc.mockResolvedValue({error:null,data:{legacy_movements:0,rows:[row({net_cents:9007199254740992})]}});
    await expect(revenueSummaryInRange(RANGE)).rejects.toThrow();
  });
});
