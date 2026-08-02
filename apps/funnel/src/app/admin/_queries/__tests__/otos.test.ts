import { beforeEach, describe, expect, it, vi } from 'vitest';

// ../otos exposes otoCountsPerOffer(range) -> OtoMetric[] where each entry
// corresponds to a Solidgate-catalog slug starting with 'oto*'. Each metric has
// offer, pattern, count, amountEurCents. `pattern` is the FULL catalog
// offering code, matched with .eq() on orders.product_slug — sibling codes
// share prefixes, so a substring match would fold offers together.

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

describe('otos query', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    // Single stable currency to avoid FX-rate parsing variance in this test.
    process.env.ADMIN_FX_RATES = '';
  });

  it('otoCountsPerOffer enumerates catalog-derived patterns', async () => {
    // Sanity: the Solidgate catalog exposes oto* slugs; the implementation
    // enumerates these (one pattern per offer, shared across locales/PSPs).
    const { PRODUCT_ID_TO_CODE, SOLIDGATE_PRODUCT_CODES } = await import(
      '@repo/shared/solidgate/catalog'
    );
    const otoKeys = Object.keys(PRODUCT_ID_TO_CODE).filter((k) => k.startsWith('oto'));
    expect(otoKeys.length).toBeGreaterThan(0);

    // Stub supabase: every orders.select returns one EUR row with 1000 cents,
    // so each oto offer reports count=1 / amountEurCents=1000.
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((_table: string) => ({
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            lt: vi
              .fn()
              .mockResolvedValue({
                data: [{ amount_cents: 1000, currency: 'eur' }],
                error: null,
              }),
          })),
        })),
      }),
    }));

    const { otoCountsPerOffer } = await import('../otos');
    const result = await otoCountsPerOffer(RANGE);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(otoKeys.length);
    for (const metric of result) {
      expect(metric.offer.startsWith('oto')).toBe(true);
      // The full catalog offering code, verbatim.
      expect(metric.pattern).toBe(
        (PRODUCT_ID_TO_CODE as Record<string, string>)[metric.offer],
      );
      expect(metric.count).toBe(1);
      expect(metric.amountEurCents).toBe(1000);
    }
    // Every offer resolves to a DISTINCT code: sibling bundles share a prefix,
    // and folding them together would silently triple-count one offer.
    const codes = result.map((r) => r.pattern);
    expect(new Set(codes).size).toBe(codes.length);
    // Spot-check two well-known offers.
    const addon = result.find((r) => r.offer === 'oto2_addon_weekly');
    expect(addon?.pattern).toBe(SOLIDGATE_PRODUCT_CODES.addon);
    const life = result.find((r) => r.offer === 'oto1_lifetime');
    expect(life?.pattern).toBe(SOLIDGATE_PRODUCT_CODES.lifetime);
  });
});
