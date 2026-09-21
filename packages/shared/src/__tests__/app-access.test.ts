import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, error: null as { message: string } | null }));
vi.mock('../supabase/admin', () => ({ getSupabaseAdminClient: () => ({ from: () => {
  const chain = { select: () => chain, eq: () => chain, then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: mocks.rows, error: mocks.error }).then(resolve) };
  return chain;
} }) }));
import { appAccessEntitlementState, APP_ACCESS_PENDING_WINDOW_MS } from '../entitlements';
const now = Date.parse('2026-09-14T10:00:00Z');
const main = { product_slug: 'trial1', status: 'active', access_level: 'full', revoked_at: null, expires_at: '2026-10-01T00:00:00Z', granted_at: '2026-09-01T00:00:00Z' };
describe('paid app access boundary', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); mocks.rows = []; mocks.error = null; });
  afterEach(() => vi.useRealTimers());
  it('does not grant content to an authenticated account without an entitlement', async () => {
    expect(await appAccessEntitlementState('user')).toBe('none');
  });
  it('does not grant content on a database read failure', async () => {
    mocks.error = { message: 'unavailable' };
    expect(await appAccessEntitlementState('user')).toBe('unavailable');
  });
  it('recognizes a valid main entitlement and a valid finite grace period', async () => {
    mocks.rows = [main]; expect(await appAccessEntitlementState('user')).toBe('active');
    mocks.rows = [{ ...main, status: 'past_due', access_level: 'grace' }]; expect(await appAccessEntitlementState('user')).toBe('active');
  });
  it('provides bounded confirmation at renewal then requires recovery', async () => {
    mocks.rows = [{ ...main, expires_at: new Date(now - 1).toISOString() }];
    expect(await appAccessEntitlementState('user')).toBe('pending');
    vi.setSystemTime(now + APP_ACCESS_PENDING_WINDOW_MS);
    expect(await appAccessEntitlementState('user')).toBe('none');
  });
  it.each([{ revoked_at: '2026-09-14T09:59:00Z' }, { status: 'canceled' }])('locks explicit revocation without a grace gap: %o', async (change) => {
    mocks.rows = [{ ...main, ...change }]; expect(await appAccessEntitlementState('user')).toBe('revoked');
  });
  it('does not let an add-on alone open the member area', async () => {
    mocks.rows = [{ ...main, product_slug: 'oto2_addon_weekly' }]; expect(await appAccessEntitlementState('user')).toBe('none');
  });
  it('does not grant perpetual subscription access from a missing expiry', async () => {
    mocks.rows = [{ ...main, expires_at: null }]; expect(await appAccessEntitlementState('user')).toBe('none');
    mocks.rows = [{ ...main, expires_at: null, status: 'past_due', access_level: 'grace' }]; expect(await appAccessEntitlementState('user')).toBe('none');
    mocks.rows = [{ ...main, expires_at: null, product_slug: 'oto1_lifetime' }]; expect(await appAccessEntitlementState('user')).toBe('active');
  });

});
