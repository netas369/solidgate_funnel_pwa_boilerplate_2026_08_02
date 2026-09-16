import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCookieGet = vi.fn();
const mockVerifyPaymentCookie = vi.fn();
const mockPromote = vi.fn(async () => {});
const claimedSessionMaybeSingle = vi.fn();
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mockCookieGet }) }));
vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access', verifyPaymentCookie: mockVerifyPaymentCookie,
}));

// ─── Rate-limit mock ──────────────────────────────────────────────────────────
const mockCheckOtpRateLimit = vi.fn();
const mockRecordOtpAttempt = vi.fn().mockResolvedValue(undefined);

vi.mock('@repo/shared/auth/otp-rate-limit', () => ({
  checkOtpRateLimit: mockCheckOtpRateLimit,
  recordOtpAttempt: mockRecordOtpAttempt,
}));

// ─── Customer-ownership mock ─────────────────────────────────────────────────
vi.mock('@repo/shared/solidgate/account-vault', () => ({
  promoteSessionVaultToAccount: mockPromote,
}));

// ─── Entitlements mock ───────────────────────────────────────────────────────
const mockUpsertEntitlement = vi.fn();
const mockResolveProductSlug = vi.fn(() => null as string | null);
const mockAdminRpc = vi.fn();

vi.mock('@repo/shared/entitlements', () => ({
  upsertEntitlement: mockUpsertEntitlement,
  resolveProductSlug: mockResolveProductSlug,
}));

const verifyOtp = vi.fn();

// Admin client mock: supports chained .from().select().eq().is().maybeSingle(),
// .from().update().in().is(), and .from().select().eq().order().maybeSingle()
const unlinkedSessionsIs = vi.fn().mockResolvedValue({ data: null, error: null });
const unlinkedSessionsEq = vi.fn(() => ({ is: unlinkedSessionsIs }));
const unlinkedSessionsSelect = vi.fn(() => ({ eq: unlinkedSessionsEq }));

const linkedSessionMaybeSingle = vi.fn();
const linkedSessionOrder = vi.fn(() => ({ maybeSingle: linkedSessionMaybeSingle }));
const linkedSessionEq = vi.fn(() => ({ order: linkedSessionOrder }));
const linkedSessionSelect = vi.fn(() => ({ eq: linkedSessionEq }));

const latestSessionLocaleMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
const latestSessionLocaleLimit = vi.fn(() => ({ maybeSingle: latestSessionLocaleMaybeSingle }));
const latestSessionLocaleOrder = vi.fn(() => ({ limit: latestSessionLocaleLimit }));
const latestSessionLocaleNot = vi.fn(() => ({ order: latestSessionLocaleOrder }));
const latestSessionLocaleIn = vi.fn(() => ({ not: latestSessionLocaleNot }));

const existingPrefsMaybeSingle = vi.fn().mockResolvedValue({
  data: { user_id: 'user-1' },
  error: null,
});
const existingPrefsEq = vi.fn(() => ({ maybeSingle: existingPrefsMaybeSingle }));

const updateIs = vi.fn().mockResolvedValue({ error: null });
const updateIn = vi.fn();
const updateEq = vi.fn();
const updateChain = { in: updateIn, eq: updateEq, is: updateIs };
updateIn.mockImplementation(() => updateChain);
updateEq.mockImplementation(() => updateChain);
const updateFn = vi.fn((_patch: Record<string, unknown>) => updateChain);

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: {
      verifyOtp,
    },
  })),
}));

// Generic orders.select chain for Phase 1007 entitlement queries.
const linkedOrdersResult = vi.fn().mockResolvedValue({ data: [], error: null });
const ordersSelectEq = vi.fn();
const ordersSelectIn = vi.fn();
const ordersSelectQuery = { eq: ordersSelectEq, in: ordersSelectIn };
ordersSelectEq.mockImplementation(() => ordersSelectQuery);
ordersSelectIn.mockImplementation((column: string) => (
  column === 'status' ? linkedOrdersResult() : ordersSelectQuery
));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    rpc: mockAdminRpc,
    from: vi.fn((table: string) => {
      if (table === 'sessions') {
        // Return an object whose select dispatches based on the column string:
        // - 'id' → unlinked sessions lookup
        // - anything else (e.g., 'last_oto_step, updated_at') → linked session resume lookup
        return {
          select: (columns: string) => {
            if (columns === 'id') {
              return { eq: unlinkedSessionsEq };
            }
            if (columns === 'locale') {
              return { in: latestSessionLocaleIn };
            }
            if (columns === 'email, user_id') {
              return { eq: vi.fn(() => ({ maybeSingle: claimedSessionMaybeSingle })) };
            }
            return { eq: linkedSessionEq };
          },
          update: updateFn,
        };
      }
      if (table === 'orders') {
        return {
          update: updateFn,
          select: vi.fn(() => ordersSelectQuery),
        };
      }
      if (table === 'user_prefs') {
        return {
          select: vi.fn(() => ({ eq: existingPrefsEq })),
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      if (table === 'entitlements') {
        return {
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      return { select: vi.fn(), update: updateFn };
    }),
  })),
}));

async function postRoute(body: unknown) {
  const { POST } = await import('../route');

  return POST(
    new Request('http://localhost/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function arrangeSolidgateMainOtpBackfill() {
  verifyOtp.mockResolvedValue({
    data: { user: { id: 'user-1' }, session: { access_token: 'token' } },
    error: null,
  });
  unlinkedSessionsIs.mockResolvedValue({
    data: [{ id: 'session-special-free' }],
    error: null,
  });
  linkedOrdersResult.mockResolvedValue({
    data: [{
      id: 'special-free-order-id',
      psp: 'solidgate',
      product_name: 'BRAND_000000_SUB',
      product_slug: 'BRAND_000000_SUB',
      status: 'trialing',
      created_at: '2026-07-21T10:00:00.000Z',
      amount_cents: 0,
      solidgate_original_amount_cents: 0,
      solidgate_subscription_id: 'sub-special-free',
    }],
    error: null,
  });
  linkedSessionMaybeSingle.mockResolvedValue({
    data: { last_oto_step: '1', updated_at: new Date().toISOString() },
    error: null,
  });
}

describe('POST /api/auth/verify-otp', () => {
  beforeEach(() => {
    mockCookieGet.mockReset();
    mockVerifyPaymentCookie.mockReset();
    mockPromote.mockClear();
    claimedSessionMaybeSingle.mockReset().mockResolvedValue({ data: { email: 'buyer@example.com', user_id: 'user-1' }, error: null });
    updateFn.mockClear();
    verifyOtp.mockReset();
    linkedSessionMaybeSingle.mockReset();
    linkedSessionOrder.mockClear();
    linkedSessionEq.mockClear();
    linkedSessionSelect.mockClear();
    unlinkedSessionsIs.mockReset().mockResolvedValue({ data: null, error: null });
    unlinkedSessionsEq.mockClear();
    unlinkedSessionsSelect.mockClear();
    latestSessionLocaleMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
    existingPrefsMaybeSingle.mockReset().mockResolvedValue({
      data: { user_id: 'user-1' },
      error: null,
    });
    updateIn.mockClear().mockImplementation(() => updateChain);
    updateEq.mockClear().mockImplementation(() => updateChain);
    updateIs.mockReset().mockResolvedValue({ error: null });
    linkedOrdersResult.mockReset().mockResolvedValue({ data: [], error: null });
    ordersSelectEq.mockClear();
    ordersSelectIn.mockClear();
    ordersSelectEq.mockImplementation(() => ordersSelectQuery);
    ordersSelectIn.mockImplementation((column: string) => (
      column === 'status' ? linkedOrdersResult() : ordersSelectQuery
    ));
    mockAdminRpc.mockReset().mockResolvedValue({ data: true, error: null });
    mockUpsertEntitlement.mockReset();
    mockResolveProductSlug.mockReset().mockReturnValue(null);
    // Default: rate limit allows the request through; clear call history each test
    mockCheckOtpRateLimit.mockClear();
    mockCheckOtpRateLimit.mockResolvedValue({ allowed: true });
    mockRecordOtpAttempt.mockClear();
    mockRecordOtpAttempt.mockResolvedValue(undefined);
  });

  it('returns an active OTO redirect after a valid OTP verification', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'token' } },
      error: null,
    });
    // Use a recent timestamp (within 24h window) so resolvePostLoginDestination returns /oto/3
    linkedSessionMaybeSingle.mockResolvedValue({
      data: {
        last_oto_step: '3',
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
      error: null,
    });

    const res = await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, redirectTo: '/oto/3' });
    expect(verifyOtp).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      token: '123456',
      type: 'email',
    });
  });

  it('returns the dashboard redirect when the linked session is expired', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'token' } },
      error: null,
    });
    linkedSessionMaybeSingle.mockResolvedValue({
      data: {
        last_oto_step: '3',
        updated_at: '2026-04-04T11:59:59.000Z',
      },
      error: null,
    });

    const res = await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, redirectTo: '/dashboard' });
  });

  it('returns 400 when the token is invalid or expired', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Token has expired or is invalid' },
    });

    const res = await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid or expired code' });
  });

  // ─── C3: rate-limit tests ───────────────────────────────────────────────────

  it('returns 429 with soft_lock message when rate limit soft-locks', async () => {
    mockCheckOtpRateLimit.mockResolvedValue({
      allowed: false,
      reason: 'soft_lock',
      retryAfterMinutes: 15,
    });

    const res = await postRoute({ email: 'attacker@example.com', token: '000000' });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/wait 15 minutes/i);
    // Must NOT have called verifyOtp at all
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('returns 429 with hard_lock message when rate limit hard-locks', async () => {
    mockCheckOtpRateLimit.mockResolvedValue({
      allowed: false,
      reason: 'hard_lock',
      retryAfterMinutes: 60,
    });

    const res = await postRoute({ email: 'attacker@example.com', token: '000000' });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/contact support/i);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('records a failure attempt when token verification fails', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Token has expired or is invalid' },
    });

    await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(mockRecordOtpAttempt).toHaveBeenCalledWith(
      'buyer@example.com',
      false,
      null, // no x-forwarded-for / x-real-ip headers in test requests
    );
  });

  it('records a success attempt when token verification succeeds', async () => {
    verifyOtp.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: { access_token: 'token' } },
      error: null,
    });
    linkedSessionMaybeSingle.mockResolvedValue({
      data: { last_oto_step: '3', updated_at: '2026-04-06T10:00:00.000Z' },
      error: null,
    });

    await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(mockRecordOtpAttempt).toHaveBeenCalledWith(
      'buyer@example.com',
      true,
      null, // no x-forwarded-for / x-real-ip headers in test requests
    );
  });

  it('routes a Solidgate main OTP backfill through the chronological grant RPC', async () => {
    arrangeSolidgateMainOtpBackfill();

    const res = await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledWith('grant_solidgate_main_entitlement', {
      p_payment_environment: 'sandbox',
      p_order_id: 'special-free-order-id',
      p_user_id: 'user-1',
      p_product_slug: 'BRAND_000000_SUB',
      p_subscription_id: 'sub-special-free',
      p_amount_cents: 0,
      p_fallback_expires_at: '2026-07-28T10:00:00.000Z',
    });
    expect(mockUpsertEntitlement).not.toHaveBeenCalled();
  });

  it('does not blindly upsert when the Solidgate main OTP RPC rejects an older order', async () => {
    arrangeSolidgateMainOtpBackfill();
    mockAdminRpc.mockResolvedValue({ data: false, error: null });

    const res = await postRoute({ email: 'buyer@example.com', token: '123456' });

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledOnce();
    expect(mockUpsertEntitlement).not.toHaveBeenCalled();
  });

  it('does not promote unrelated anonymous checkouts when the mailbox owner logs in', async () => {
    arrangeSolidgateMainOtpBackfill();
    const response = await postRoute({ email: 'buyer@example.com', token: '123456' });
    expect(response.status).toBe(200);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(updateFn.mock.calls.some(([patch]) => 'auth_verified_at' in patch)).toBe(false);
  });

  it('claims a prelinked account card only for the current signed purchase journey after OTP', async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1', email: 'buyer@example.com' } }, error: null });
    linkedSessionMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockCookieGet.mockReturnValue({ value: 'signed-current-purchase' });
    mockVerifyPaymentCookie.mockResolvedValue({ sessionId: 'current-session' });
    const response = await postRoute({ email: 'buyer@example.com', token: '123456' });
    expect(response.status).toBe(200);
    expect(mockPromote).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1', sessionId: 'current-session', paymentEnvironment: 'sandbox',
    });
    expect(updateFn).toHaveBeenCalledWith({ claimed_at: expect.any(String), auth_verified_at: expect.any(String) });
    expect(updateEq).toHaveBeenCalledWith('session_id', 'current-session');
    expect(updateEq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(updateEq).toHaveBeenCalledWith('solidgate_customer_email', 'buyer@example.com');
  });

  it.each([
    { email: 'other@example.com', user_id: 'user-1' },
    { email: 'buyer@example.com', user_id: 'other-user' },
  ])('does not promote a mismatched payment-cookie purchase: %o', async (session) => {
    verifyOtp.mockResolvedValue({ data: { user: { id: 'user-1', email: 'buyer@example.com' } }, error: null });
    linkedSessionMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockCookieGet.mockReturnValue({ value: 'signed-other-purchase' });
    mockVerifyPaymentCookie.mockResolvedValue({ sessionId: 'other-session' });
    claimedSessionMaybeSingle.mockResolvedValue({ data: session, error: null });
    const response = await postRoute({ email: 'buyer@example.com', token: '123456' });
    expect(response.status).toBe(200);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(updateFn.mock.calls.some(([patch]) => 'auth_verified_at' in patch)).toBe(false);
  });
});
