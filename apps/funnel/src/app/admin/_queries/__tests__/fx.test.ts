import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GREEN (Plan 04): ../fx exports convertToEur(amountCents, currency)
// which reads ADMIN_FX_RATES env (format: "CODE:RATE,CODE:RATE,...") and
// returns amountCents * rate. Missing currencies fall back to 1.0 with console.warn.

describe('fx query (GREEN — Plan 04 implementation)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_FX_RATES = 'USD:0.92,GBP:1.17';
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.ADMIN_FX_RATES;
  });

  it('convertToEur applies ADMIN_FX_RATES map', async () => {
    const { convertToEur, ADMIN_FX_RATES } = await import('../fx');
    expect(ADMIN_FX_RATES.USD).toBeCloseTo(0.92);
    expect(ADMIN_FX_RATES.GBP).toBeCloseTo(1.17);
    expect(convertToEur(1000, 'USD')).toBe(920);
    expect(convertToEur(1000, 'GBP')).toBe(1170);
    // EUR passes through unchanged.
    expect(convertToEur(1000, 'EUR')).toBe(1000);
    expect(convertToEur(1000, 'eur')).toBe(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('convertToEur scales zero-decimal JPY to cent-space before applying the rate', async () => {
    process.env.ADMIN_FX_RATES = 'JPY:0.0054';
    vi.resetModules();
    const { convertToEur } = await import('../fx');
    // Orders store whole yen (¥926 ≈ €5.00). With the naturally-quoted
    // per-yen rate, the result must be 926 × 100 × 0.0054 ≈ 500 EUR cents —
    // not 5, which is what treating yen as cents would produce.
    expect(convertToEur(926, 'JPY')).toBe(500);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('convertToEur falls back to 1.0 and console.warns when currency missing', async () => {
    const { convertToEur } = await import('../fx');
    expect(convertToEur(1000, 'XYZ')).toBe(1000);
    expect(warnSpy).toHaveBeenCalled();
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('XYZ');
  });
});
