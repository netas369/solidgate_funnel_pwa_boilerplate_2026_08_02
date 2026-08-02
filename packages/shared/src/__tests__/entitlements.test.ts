import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock admin client ───────────────────────────────────────────────────────
const mockUpsert = vi.fn();
const mockMaybeSingle = vi.fn();
const mockOrder = vi.fn();
const mockEqCalls: Array<[string, unknown]> = [];
const mockOrCalls: string[] = [];
const mockIsCalls: Array<[string, unknown]> = [];

vi.mock('../supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table !== 'entitlements') throw new Error(`Unexpected table: ${table}`);
      // Build a deeply chainable mock where every method returns the same
      // chainable proxy.
      //
      // `.maybeSingle()` is the terminal for hasEntitlement (resolves to
      // mockMaybeSingle). `.order()` is the terminal for getUserEntitlements -
      // it returns a thenable that resolves to mockOrder's configured value.
      const chainable: Record<string, unknown> = {};
      chainable.eq = vi.fn((col: string, val: unknown) => {
        mockEqCalls.push([col, val]);
        return chainable;
      });
      chainable.is = vi.fn((col: string, val: unknown) => {
        mockIsCalls.push([col, val]);
        return chainable;
      });
      chainable.not = vi.fn(() => chainable);
      chainable.or = vi.fn((filter: string) => {
        mockOrCalls.push(filter);
        return chainable;
      });
      chainable.limit = vi.fn(() => chainable);
      chainable.maybeSingle = mockMaybeSingle;
      // getUserEntitlements awaits the return of `.order(...)` directly, so the
      // returned value must be a thenable that resolves to mockOrder's value.
      chainable.order = vi.fn(() => ({
        then: (
          onFulfilled: (v: unknown) => unknown,
          onRejected?: (r: unknown) => unknown,
        ) => Promise.resolve(mockOrder()).then(onFulfilled, onRejected),
      }));

      return {
        upsert: mockUpsert,
        select: vi.fn(() => chainable),
      };
    }),
  })),
}));


import {
  upsertEntitlement,
  hasEntitlement,
  getUserEntitlements,
  resolveProductSlug,
  PRODUCT_NAME_TO_SLUG,
} from '../entitlements';
import { PRODUCT_ID_TO_CODE } from '../solidgate/catalog';
import { PRICE_MAP } from '../price-map';

describe('upsertEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEqCalls.length = 0;
    mockOrCalls.length = 0;
    mockIsCalls.length = 0;
  });

  it('calls admin.from("entitlements").upsert with correct shape and onConflict', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
      orderId: 'order-456',
      source: 'grant',
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [data, opts] = mockUpsert.mock.calls[0];
    expect(data).toMatchObject({
      payment_environment: 'sandbox',
      user_id: 'user-123',
      product_slug: 'trial1',
      access_level: 'full',
      order_id: 'order-456',
      source: 'grant',
    });
    expect(data.updated_at).toBeDefined();
    expect(opts).toEqual({
      onConflict: 'payment_environment,user_id,product_slug',
    });
  });

  it('keeps production grants on a separate conflict key', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
      paymentEnvironment: 'production',
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ payment_environment: 'production' }),
      { onConflict: 'payment_environment,user_id,product_slug' },
    );
  });

  it('writes solidgate_subscription_id when solidgateSubscriptionId is provided', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'oto2_addon_weekly',
      accessLevel: 'trial',
      source: 'charge-off-session',
      solidgateSubscriptionId: 'sub_test_123',
    });

    const [data] = mockUpsert.mock.calls[0];
    expect(data.solidgate_subscription_id).toBe('sub_test_123');
  });

  it('writes solidgate_subscription_id as null when not provided', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });

    const [data] = mockUpsert.mock.calls[0];
    expect(data.solidgate_subscription_id).toBeNull();
  });

  it('logs error but does not throw when upsert returns an error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockResolvedValue({ error: { message: 'unique violation' } });

    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[entitlements] upsert failed:',
      'unique violation',
    );
    consoleSpy.mockRestore();
  });

  it('catches exceptions from admin client and does not throw', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockRejectedValue(new Error('connection refused'));

    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[entitlements] upsert failed:',
      'connection refused',
    );
    consoleSpy.mockRestore();
  });

  // Phase 260517-regrant: helper must always reset status='active' and
  // clear revoked_at so a re-grant against a past_due+revoked row from a
  // prior payment failure produces a row the dashboard treats as active.
  // Without this, the dashboard's .eq('status','active') filter leaves the
  // UI locked even after a successful re-purchase.
  it('requests status=active and revoked_at=null for a new-order re-grant (DB guards same-order replay)', async () => {
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'oto2_addon_weekly',
      accessLevel: 'full',
      solidgateSubscriptionId: 'sub_recover_test',
    });

    const [data] = mockUpsert.mock.calls[0];
    expect(data.status).toBe('active');
    expect(data.revoked_at).toBeNull();
  });
});

describe('hasEntitlement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEqCalls.length = 0;
    mockOrCalls.length = 0;
    mockIsCalls.length = 0;
  });

  it('returns true when query returns a row', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'ent-abc' }, error: null });

    const result = await hasEntitlement('user-123', 'trial1');
    expect(result).toBe(true);
  });

  it('returns false when query returns null', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await hasEntitlement('user-123', 'trial1');
    expect(result).toBe(false);
  });

  it('filters by status active OR (past_due AND grace) via .or()', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await hasEntitlement('user-123', 'trial1');

    // Honors the grace window the payment-failure webhook
    // writes (status='past_due' + access_level='grace'). Active rows still pass.
    expect(mockOrCalls).toContain(
      'status.eq.active,and(status.eq.past_due,access_level.eq.grace)',
    );
  });

  it("does NOT add a .eq('status', ...) call (legacy filter must be gone)", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await hasEntitlement('user-123', 'trial1');

    const statusCall = mockEqCalls.find(([col]) => col === 'status');
    expect(statusCall).toBeUndefined();
  });

  it('still filters by environment, user_id, product_slug, and revoked_at IS NULL', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    await hasEntitlement('user-123', 'trial1');

    expect(mockEqCalls).toContainEqual(['payment_environment', 'sandbox']);
    expect(mockEqCalls).toContainEqual(['user_id', 'user-123']);
    expect(mockEqCalls).toContainEqual(['product_slug', 'trial1']);
    expect(mockIsCalls).toContainEqual(['revoked_at', null]);
  });
});

describe('getUserEntitlements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEqCalls.length = 0;
  });

  it('returns array of entitlements when query returns rows', async () => {
    const rows = [
      {
        product_slug: 'trial1',
        access_level: 'full',
        granted_at: '2026-01-01T00:00:00Z',
        order_id: 'order-1',
        expires_at: null,
      },
    ];
    mockOrder.mockResolvedValue({ data: rows, error: null });

    const result = await getUserEntitlements('user-123');
    expect(result).toEqual(rows);
    expect(mockEqCalls).toContainEqual(['payment_environment', 'sandbox']);
  });

  it('returns empty array when query returns null', async () => {
    mockOrder.mockResolvedValue({ data: null, error: null });

    const result = await getUserEntitlements('user-123');
    expect(result).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveProductSlug / PRODUCT_NAME_TO_SLUG
//
// orders.product_name stores the locale-coded "company code" productName from
// PRICE_MAP[slug][locale].productName (e.g. EN_BRAND_000000_SUB,
// EN_BRANDADDON_000000_SUB, EN_BRANDPDF5_000000_PDF). resolveProductSlug
// reverse-maps that company code back to a PRICE_MAP slug.
//
// Design note (current PRICE_MAP): the 7 subscription tiers (trial1-4,
// trial_monthly, special_1eur, special_free) all share ONE company code per
// locale - `{PREFIX}_BRAND_000000_SUB`. PRODUCT_NAME_TO_SLUG is built via
// Object.fromEntries, so for those shared names the LAST PRICE_MAP entry wins.
// Per-OTO company codes are unique, so OTOs resolve 1:1.
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveProductSlug', () => {
  it('returns a slug for a known subscription company code', () => {
    // EN_BRAND_000000_SUB is the shared subscription company code; it resolves
    // to one of the 7 subscription slugs.
    const slug = resolveProductSlug('EN_BRAND_000000_SUB');
    expect(slug).not.toBeNull();
    expect([
      'trial1',
      'trial2',
      'trial3',
      'trial4',
      'trial_monthly',
      'special_1eur',
      'special_free',
    ]).toContain(slug);
  });

  it('returns the add-on slug for the add-on company code', () => {
    expect(resolveProductSlug('EN_BRANDADDON_000000_SUB')).toBe('oto2_addon_weekly');
  });

  it('returns the pdf5 slug for the pdf5 OTO company code', () => {
    expect(resolveProductSlug('EN_BRANDPDF5_000000_PDF')).toBe('oto5_pdf');
  });

  it('returns the lifetime slug for the lifetime OTO company code', () => {
    expect(resolveProductSlug('EN_BRANDLIFETIME_000000_SUB')).toBe('oto1_lifetime');
  });

  it('returns null for unknown product name', () => {
    expect(resolveProductSlug('Unknown Product')).toBeNull();
  });
});

describe('PRODUCT_NAME_TO_SLUG', () => {
  it('resolves BOTH code shapes: locale-prefixed names and locale-agnostic catalog codes', () => {
    // The reverse map deduplicates by name, so it holds every unique
    // locale-coded company code PLUS every locale-agnostic offering code. Both
    // must resolve forever: history keeps the prefixed codes, PSP-issued orders
    // have none. Dropping the locale-agnostic half leaves a buyer's purchased
    // downloads invisible in the PWA library and unnamed on the OTO-8 summary.
    const localeCodedNames = new Set(
      Object.values(PRICE_MAP).flatMap((byLocale) =>
        Object.values(byLocale).map((p) => p.productName),
      ),
    );
    const catalogCodes = new Set(Object.values(PRODUCT_ID_TO_CODE));

    for (const name of localeCodedNames) {
      expect(PRODUCT_NAME_TO_SLUG[name], `locale-coded name ${name}`).toBeDefined();
    }
    for (const code of catalogCodes) {
      expect(PRODUCT_NAME_TO_SLUG[code], `catalog code ${code}`).toBeDefined();
    }
    // No stragglers: exactly the union of the two vocabularies. (This is also
    // what proves no dead marketing-anchor slugs leak back into the map.)
    expect(Object.keys(PRODUCT_NAME_TO_SLUG).length).toBe(
      new Set([...localeCodedNames, ...catalogCodes]).size,
    );
  });

  it('maps every PRICE_MAP productName to a slug that exists in PRICE_MAP', () => {
    // Every value in the reverse map must be a real PRICE_MAP key. (For
    // subscription company codes shared by 7 tiers, last-write-wins picks one
    // of them; for OTOs the mapping is exact.)
    const priceMapSlugs = new Set(Object.keys(PRICE_MAP));
    for (const [productName, slug] of Object.entries(PRODUCT_NAME_TO_SLUG)) {
      expect(priceMapSlugs.has(slug), `${productName} → ${slug}`).toBe(true);
    }
  });

  it('resolves every OTO company code back to its exact slug (unique 1:1)', () => {
    // OTO company codes (BRANDADDON, BRANDPDF5, BRANDLIFETIME, …) are unique
    // per slug, so the round-trip is exact. Subscription tiers are excluded
    // because they deliberately share one company code.
    const SUBSCRIPTION_SLUGS = new Set([
      'trial1',
      'trial2',
      'trial3',
      'trial4',
      'trial_monthly',
      'special_1eur',
      'special_free',
    ]);
    for (const [slug, byLocale] of Object.entries(PRICE_MAP)) {
      if (SUBSCRIPTION_SLUGS.has(slug)) continue;
      for (const { productName } of Object.values(byLocale)) {
        expect(resolveProductSlug(productName)).toBe(slug);
      }
    }
  });

  it('resolves every subscription company code to a subscription slug', () => {
    // The 7 tiers share one company code, so the round-trip lands on *a* tier
    // (last-write-wins), not necessarily the originating one. Assert it lands
    // on a valid subscription slug.
    const SUBSCRIPTION_SLUGS = new Set([
      'trial1',
      'trial2',
      'trial3',
      'trial4',
      'trial_monthly',
      'special_1eur',
      'special_free',
    ]);
    for (const slug of SUBSCRIPTION_SLUGS) {
      for (const { productName } of Object.values(PRICE_MAP[slug as keyof typeof PRICE_MAP])) {
        expect(SUBSCRIPTION_SLUGS.has(resolveProductSlug(productName)!)).toBe(true);
      }
    }
  });

  it('returns null for a company code that is not in PRICE_MAP', () => {
    expect(resolveProductSlug('XX_BRAND_999999_SUB')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases  -  upsertEntitlement
// ═════════════════════════════════════════════════════════════════════════════

describe('upsertEntitlement  -  edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true on success (boolean contract)', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });
    expect(result).toBe(true);
  });

  it('returns false on DB error (boolean contract)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockResolvedValue({ error: { message: 'constraint violation' } });

    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });
    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });

  it('returns false on thrown exception (boolean contract)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockRejectedValue(new Error('pool destroyed'));

    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });
    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });

  it('returns false on non-Error exceptions (e.g. string throw)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockRejectedValue('raw string error');

    const result = await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });
    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });

  it.each(['full', 'trial', 'grace'] as const)(
    'accepts access level: %s',
    async (level) => {
      mockUpsert.mockResolvedValue({ error: null });
      const result = await upsertEntitlement({
        userId: 'user-123',
        productSlug: 'trial1',
        accessLevel: level,
      });
      expect(result).toBe(true);
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ access_level: level }),
        expect.anything(),
      );
    },
  );

  it('defaults optional fields to null when not provided', async () => {
    mockUpsert.mockResolvedValue({ error: null });
    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });
    const [data] = mockUpsert.mock.calls[0];
    expect(data.order_id).toBeNull();
    expect(data.expires_at).toBeNull();
    expect(data.source).toBeNull();
  });

  it('includes ISO timestamp in updated_at', async () => {
    const before = new Date().toISOString();
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'trial1',
      accessLevel: 'full',
    });

    const after = new Date().toISOString();
    const [data] = mockUpsert.mock.calls[0];
    expect(data.updated_at >= before).toBe(true);
    expect(data.updated_at <= after).toBe(true);
  });

  it('passes expires_at through when provided (trial entitlement with expiry)', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockUpsert.mockResolvedValue({ error: null });

    await upsertEntitlement({
      userId: 'user-123',
      productSlug: 'oto2_addon_weekly',
      accessLevel: 'trial',
      expiresAt,
      source: 'charge-off-session',
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        access_level: 'trial',
        expires_at: expiresAt,
        source: 'charge-off-session',
      }),
      expect.anything(),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases  -  hasEntitlement
// ═════════════════════════════════════════════════════════════════════════════

describe('hasEntitlement  -  edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false on DB error (fails closed  -  denies access)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    const result = await hasEntitlement('user-123', 'trial1');
    expect(result).toBe(false);
  });

  it('checks for every product slug without error', async () => {
    // Ensures no slug causes a runtime issue
    for (const slug of Object.keys(PRICE_MAP)) {
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });
      const result = await hasEntitlement('user-123', slug);
      expect(result).toBe(false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases  -  getUserEntitlements
// ═════════════════════════════════════════════════════════════════════════════

describe('getUserEntitlements  -  edge cases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns multiple entitlements ordered by granted_at desc', async () => {
    const rows = [
      { product_slug: 'oto1_lifetime', access_level: 'full', granted_at: '2026-04-01T00:00:00Z', order_id: 'o1', expires_at: null },
      { product_slug: 'oto5_pdf', access_level: 'full', granted_at: '2026-03-15T00:00:00Z', order_id: 'o2', expires_at: null },
      { product_slug: 'trial1', access_level: 'grace', granted_at: '2026-03-01T00:00:00Z', order_id: 'o3', expires_at: '2026-05-01T00:00:00Z' },
    ];
    mockOrder.mockResolvedValue({ data: rows, error: null });

    const result = await getUserEntitlements('user-123');
    expect(result).toHaveLength(3);
    // First should be most recent
    expect(result[0].product_slug).toBe('oto1_lifetime');
    expect(result[2].product_slug).toBe('trial1');
  });

  it('returns entitlements with non-null expires_at (grace/trial)', async () => {
    const rows = [
      { product_slug: 'oto2_addon_weekly', access_level: 'trial', granted_at: '2026-04-01T00:00:00Z', order_id: null, expires_at: '2026-04-08T00:00:00Z' },
    ];
    mockOrder.mockResolvedValue({ data: rows, error: null });

    const result = await getUserEntitlements('user-123');
    expect(result[0].expires_at).toBe('2026-04-08T00:00:00Z');
    expect(result[0].access_level).toBe('trial');
  });

  it('returns empty array on DB error (defensive, no crash)', async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const result = await getUserEntitlements('user-123');
    expect(result).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases  -  resolveProductSlug
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveProductSlug  -  edge cases', () => {
  it('is case-sensitive (does not match lowercase company code)', () => {
    expect(resolveProductSlug('en_brand_000000_sub')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveProductSlug('')).toBeNull();
  });

  it('returns null for a partial company code', () => {
    expect(resolveProductSlug('EN_BRAND')).toBeNull();
  });

  it('returns null for a company code with trailing whitespace', () => {
    expect(resolveProductSlug('EN_BRAND_000000_SUB ')).toBeNull();
  });
});
