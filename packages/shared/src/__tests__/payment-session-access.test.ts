import { beforeEach, describe, expect, it, vi } from 'vitest';

// authorizePaymentSessionAccess gates session-scoped payment reads: the caller
// is either the authenticated owner of the session, or holds the signed
// payment cookie whose Solidgate order id produced an order for that session.

const cookieGet = vi.fn();
const getUser = vi.fn();
const verifyPaymentCookie = vi.fn();
const maybeSingle = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet })),
}));

vi.mock('../payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
  verifyPaymentCookie: (...args: unknown[]) => verifyPaymentCookie(...args),
}));

vi.mock('../supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));

vi.mock('../supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle,
    })),
  })),
}));

import { authorizePaymentSessionAccess } from '../payment-session-access';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SG_ORDER_ID = `${SESSION_ID}:trial2:1`;

describe('authorizePaymentSessionAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    cookieGet.mockReturnValue(undefined);
    verifyPaymentCookie.mockResolvedValue(null);
    maybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('returns ok via account path when the authenticated user owns the session', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: 'user-1',
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedVia).toBe('account');
  });

  it('returns 401 when anonymous and the payment cookie is missing', async () => {
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it('returns 403 when the cookie belongs to a different session', async () => {
    cookieGet.mockReturnValue({ value: 'signed' });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: SG_ORDER_ID,
      sessionId: 'other-session',
      paymentIntentId: SG_ORDER_ID,
      subscriptionId: null,
    });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("returns 403 when the cookie's order id produced no order for this session", async () => {
    cookieGet.mockReturnValue({ value: 'signed' });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: SG_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: SG_ORDER_ID,
      subscriptionId: null,
    });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('returns ok via cookie path when the Solidgate order id matches an order row', async () => {
    cookieGet.mockReturnValue({ value: 'signed' });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: SG_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: SG_ORDER_ID,
      subscriptionId: null,
    });
    maybeSingle.mockResolvedValue({ data: { id: 'order-1' }, error: null });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedVia).toBe('cookie');
  });

  it("returns 403 when a logged-in user rides another buyer's cookie", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-2' } }, error: null });
    cookieGet.mockReturnValue({ value: 'signed' });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: SG_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: SG_ORDER_ID,
      subscriptionId: null,
    });
    maybeSingle.mockResolvedValue({ data: { id: 'order-1' }, error: null });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: 'user-1',
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("refuses a stale 'sub'-kind cookie (nothing mints them anymore)", async () => {
    cookieGet.mockReturnValue({ value: 'signed' });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'sub',
      id: 'sub_123',
      sessionId: SESSION_ID,
      paymentIntentId: null,
      subscriptionId: 'sub_123',
    });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('returns 500 when auth.getUser() fails with a real error', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'outage' },
    });
    const result = await authorizePaymentSessionAccess({
      requestedSessionId: SESSION_ID,
      sessionUserId: null,
      sessionPaymentIntentId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });
});
