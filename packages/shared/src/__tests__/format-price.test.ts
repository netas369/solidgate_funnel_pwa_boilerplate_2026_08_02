import { describe, it, expect, vi } from 'vitest';
import type { Currency, Locale } from '../price-map';
import { formatPrice } from '../format-price';

describe('formatPrice', () => {
  it('formats EUR for en locale with symbol prefix and 2 decimals', () => {
    expect(formatPrice(9900, 'eur', 'en')).toBe('\u20AC99.00');
  });

  it('formats CZK for cs locale with thin/no-break space and Kč suffix', () => {
    const out = formatPrice(249900, 'czk', 'cs');
    // Modern Czech ICU formats CZK with haléř decimals (,00) and thin/no-break
    // grouping space  -  e.g. "2 499,00 Kč". Match the integer thousands grouping
    // as a substring per frontmatter contract.
    expect(out).toMatch(/2[\s\u202f\u00a0]499/);
    expect(out).toContain('Kč');
  });

  it('formats TWD as decimal currency (divides by 100) for zh-TW', () => {
    // NT$3,299 is stored as 329900 minor units (TWD is treated as decimal).
    const out = formatPrice(329900, 'twd', 'zh-TW');
    expect(out).toMatch(/NT\$3,?299/);
  });

  it('formats TWD weekly add-on price (decimal)', () => {
    const out = formatPrice(89900, 'twd', 'zh-TW');
    expect(out).toMatch(/NT\$899/);
  });

  it('formats CZK weekly add-on price (decimal divide)', () => {
    const out = formatPrice(69900, 'czk', 'cs');
    // 69900 haléř → 699,00 Kč (modern Czech ICU includes haléř decimals)
    expect(out).toContain('699');
    expect(out).toContain('Kč');
  });

  it('formats USD for ru locale with comma decimal and $ symbol', () => {
    const out = formatPrice(999, 'usd' as unknown as Currency, 'ru');
    expect(out).toContain('9,99');
    expect(out).toContain('$');
  });

  it('formats zero EUR as €0.00 (zero is first-class)', () => {
    expect(formatPrice(0, 'eur', 'en')).toBe('\u20AC0.00');
  });

  it('formats zero CZK as 0,00 Kč', () => {
    const out = formatPrice(0, 'czk', 'cs');
    expect(out).toMatch(/^0,00[\s\u202f\u00a0]?Kč$/);
  });

  it('formats zero TWD as NT$0.00 (decimal)', () => {
    const out = formatPrice(0, 'twd', 'zh-TW');
    expect(out).toMatch(/NT\$0\.00/);
  });

  it('does not crash on uppercase currency code', () => {
    expect(() => formatPrice(9900, 'EUR' as unknown as Currency, 'en')).not.toThrow();
    expect(formatPrice(9900, 'EUR' as unknown as Currency, 'en')).toBe('\u20AC99.00');
  });

  it('falls back to en-IE/EUR on unknown locale and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = formatPrice(9900, 'eur', 'xx' as unknown as Locale);
    expect(out).toBe('\u20AC99.00');
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('[formatPrice]');
    expect(msg).toContain('xx');
    warnSpy.mockRestore();
  });
});
