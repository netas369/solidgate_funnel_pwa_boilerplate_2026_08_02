import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
describe('explicit currency conversion', () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv('ADMIN_FX_RATES', 'USD:0.92,GBP:1.17'); });
  afterEach(() => vi.unstubAllEnvs());
  it('converts configured currencies, keeps EUR exact and refunds negative', async () => {
    const { convertToEur } = await import('../fx');
    expect(convertToEur(1000, 'USD')).toBe(920);
    expect(convertToEur(-1000, 'GBP')).toBe(-1170);
    expect(convertToEur(1000, 'eur')).toBe(1000);
  });
  it('never represents missing or invalid FX as a 1:1 conversion', async () => {
    vi.stubEnv('ADMIN_FX_RATES', 'USD:0,GBP:-2,CAD:0.9garbage,AUD:Infinity');
    const { convertToEur } = await import('../fx');
    for (const code of ['USD','GBP','CAD','AUD','XYZ']) expect(convertToEur(1000, code)).toBeNull();
    expect(convertToEur(0, 'XYZ')).toBe(0);
  });
  it('converts JPY whole yen to EUR cents and rejects unsafe inputs', async () => {
    vi.stubEnv('ADMIN_FX_RATES', 'JPY:0.0054');
    const { convertToEur } = await import('../fx');
    expect(convertToEur(926, 'JPY')).toBe(500);
    expect(() => convertToEur(Number.MAX_SAFE_INTEGER + 1, 'EUR')).toThrow();
  });
});
