import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Payment cookie mock ───────────────────────────────────────────────────────
const mockVerifyPaymentCookie = vi.fn();

vi.mock('@repo/shared/payment-cookie', () => ({
  verifyPaymentCookie: mockVerifyPaymentCookie,
  PAYMENT_COOKIE_NAME: 'payment_access',
}));

// ─── Cookies mock ─────────────────────────────────────────────────────────────
const mockCookieGet = vi.fn();

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: mockCookieGet,
  })),
}));

// ─── Supabase admin mock ───────────────────────────────────────────────────────
const mockCreateUser = vi.fn();
const mockGenerateLink = vi.fn();
const mockAdminRpc = vi.fn();
const mockUpsertEntitlement = vi.fn();

// Chain for sessions.select().eq().maybeSingle()
const sessionsMaybeSingle = vi.fn();
const sessionsEqForSelect = vi.fn<
  (column: string, value: unknown) => { maybeSingle: typeof sessionsMaybeSingle }
>(() => ({ maybeSingle: sessionsMaybeSingle }));
const sessionsSelect = vi.fn(() => ({ eq: sessionsEqForSelect }));

// Chain for sessions.update().eq() (no return needed)
const sessionsUpdateEq = vi.fn().mockResolvedValue({ error: null });
const sessionsUpdate = vi.fn(() => ({ eq: sessionsUpdateEq }));

// Chain for orders.update().eq().is()
const ordersUpdateIs = vi.fn().mockResolvedValue({ error: null });
const ordersUpdateEq = vi.fn();
const ordersUpdateChain = { eq: ordersUpdateEq, is: ordersUpdateIs };
ordersUpdateEq.mockImplementation(() => ordersUpdateChain);
const ordersUpdate = vi.fn(() => ordersUpdateChain);

// Chain for orders.select().eq().eq().eq().in() (environment + ownership).
const ordersSelectIn = vi.fn().mockResolvedValue({ data: [], error: null });
const ordersSelectEq = vi.fn();
const ordersSelectChain = { eq: ordersSelectEq, in: ordersSelectIn };
ordersSelectEq.mockImplementation(() => ordersSelectChain);
const ordersSelect = vi.fn(() => ordersSelectChain);

const mockAdminFrom = vi.fn((table: string) => {
  if (table === 'sessions') {
    return {
      select: sessionsSelect,
      update: sessionsUpdate,
    };
  }
  if (table === 'orders') {
    return {
      select: ordersSelect,
      update: ordersUpdate,
    };
  }
  if (table === 'entitlements') {
    return {
      upsert: vi.fn().mockResolvedValue({ error: null }),
    };
  }
  return {};
});

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
    rpc: mockAdminRpc,
    auth: {
      admin: {
        createUser: mockCreateUser,
        generateLink: mockGenerateLink,
      },
    },
  })),
}));

// ─── Supabase SSR client mock ──────────────────────────────────────────────────
const mockVerifyOtp = vi.fn();

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: {
      verifyOtp: mockVerifyOtp,
    },
  })),
}));

// ─── Customer-ownership mock ─────────────────────────────────────────────────
vi.mock('@repo/shared/solidgate/account-vault', () => ({
  promoteSessionVaultToAccount: vi.fn(async () => {}),
}));

// ─── Entitlements mock ────────────────────────────────────────────────────────
vi.mock('@repo/shared/entitlements', () => ({
  upsertEntitlement: mockUpsertEntitlement,
  resolveProductSlug: vi.fn(() => 'trial1'),
}));

// ─── Test helper ──────────────────────────────────────────────────────────────
async function postRoute() {
  const { POST } = await import('../route');
  return POST();
}

function arrangeSolidgateMainClaim() {
  mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
  mockVerifyPaymentCookie.mockResolvedValue({
    paymentIntentId: 'pi_test123',
    sessionId: 'session-abc',
  });
  sessionsMaybeSingle.mockResolvedValue({
    data: { email: 'claimer@example.com', user_id: null },
    error: null,
  });
  mockCreateUser.mockResolvedValue({
    data: { user: { id: 'user-claim-id' } },
    error: null,
  });
  mockGenerateLink.mockResolvedValue({
    data: {
      user: { id: 'user-claim-id' },
      properties: { hashed_token: 'tokenabc' },
    },
    error: null,
  });
  mockVerifyOtp.mockResolvedValue({ error: null });
  ordersSelectIn.mockResolvedValue({
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
}

describe('POST /api/auth/claim-purchase', () => {
  beforeEach(() => {
    vi.resetModules();
    mockVerifyPaymentCookie.mockReset();
    mockCookieGet.mockReset();
    mockCreateUser.mockReset();
    mockGenerateLink.mockReset();
    mockVerifyOtp.mockReset();
    sessionsMaybeSingle.mockReset();
    sessionsEqForSelect.mockClear();
    sessionsSelect.mockClear();
    sessionsUpdate.mockClear();
    sessionsUpdateEq.mockReset().mockResolvedValue({ error: null });
    ordersUpdate.mockClear();
    ordersUpdateEq.mockClear();
    ordersUpdateEq.mockImplementation(() => ordersUpdateChain);
    ordersUpdateIs.mockReset().mockResolvedValue({ error: null });
    ordersSelectIn.mockReset().mockResolvedValue({ data: [], error: null });
    mockAdminRpc.mockReset().mockResolvedValue({ data: true, error: null });
    mockUpsertEntitlement.mockReset();
    mockAdminFrom.mockClear();
  });

  it('returns 401 when no payment cookie is present', async () => {
    mockCookieGet.mockReturnValue(undefined);
    mockVerifyPaymentCookie.mockResolvedValue(null);

    const res = await postRoute();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when payment cookie sessionId does not match (cookie invalid)', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_invalid.session-bad.sig123' });
    mockVerifyPaymentCookie.mockResolvedValue(null); // verification fails

    const res = await postRoute();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns 400 when session has no email', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: null, user_id: null },
      error: null,
    });

    const res = await postRoute();

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'No email on session' });
  });

  it('returns 200 with authLinked: true when session already has user_id', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: 'user@example.com', user_id: 'existing-user-id' },
      error: null,
    });

    const res = await postRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, authLinked: true });
  });

  it('returns 200 with authLinked: true after full auth linking succeeds', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: 'new@example.com', user_id: null },
      error: null,
    });
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'new-user-id' } },
      error: null,
    });
    mockGenerateLink.mockResolvedValue({
      data: {
        user: { id: 'new-user-id' },
        properties: { hashed_token: 'token123' },
      },
      error: null,
    });
    mockVerifyOtp.mockResolvedValue({ error: null });

    const res = await postRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, authLinked: true });
  });

  it('returns 200 with authLinked: false when createUser fails (non-duplicate error)', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: 'fail@example.com', user_id: null },
      error: null,
    });
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: 'Server error', status: 500 },
    });

    const res = await postRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, authLinked: false });
  });

  it('proceeds via generateLink when createUser returns 422 duplicate error (existing user)', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: 'existing@example.com', user_id: null },
      error: null,
    });
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: 'User already registered', status: 422 },
    });
    mockGenerateLink.mockResolvedValue({
      data: {
        user: { id: 'existing-user-id' },
        properties: { hashed_token: 'token456' },
      },
      error: null,
    });
    mockVerifyOtp.mockResolvedValue({ error: null });

    const res = await postRoute();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, authLinked: true });
  });

  it('sets claimed_at on orders linked to the current session only (no global email sweep)', async () => {
    mockCookieGet.mockReturnValue({ value: 'pi_test123.session-abc.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_test123',
      sessionId: 'session-abc',
    });
    sessionsMaybeSingle.mockResolvedValue({
      data: { email: 'claimer@example.com', user_id: null },
      error: null,
    });
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'user-claim-id' } },
      error: null,
    });
    mockGenerateLink.mockResolvedValue({
      data: {
        user: { id: 'user-claim-id' },
        properties: { hashed_token: 'tokenabc' },
      },
      error: null,
    });
    mockVerifyOtp.mockResolvedValue({ error: null });

    const res = await postRoute();
    await res.json(); // consume body

    // Must have called orders.update with claimed_at using session_id filter (no global email sweep)
    expect(ordersUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ claimed_at: expect.any(String) }),
    );
    expect(ordersUpdateEq).toHaveBeenCalledWith('payment_environment', 'sandbox');
    expect(ordersUpdateEq).toHaveBeenCalledWith('session_id', 'session-abc');

    // Must NOT have called .eq('email', ...) for sessions (no global sweep)
    const sessionEqCalls = sessionsEqForSelect.mock.calls;
    const emailSweepCall = sessionEqCalls.find(
      (call) => call[0] === 'email' && call[1] !== undefined,
    );
    expect(emailSweepCall).toBeUndefined();
  });

  it('routes a Solidgate main backfill through the chronological grant RPC', async () => {
    arrangeSolidgateMainClaim();

    const res = await postRoute();

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledWith('grant_solidgate_main_entitlement', {
      p_payment_environment: 'sandbox',
      p_order_id: 'special-free-order-id',
      p_user_id: 'user-claim-id',
      p_product_slug: 'BRAND_000000_SUB',
      p_subscription_id: 'sub-special-free',
      p_amount_cents: 0,
      p_fallback_expires_at: '2026-07-28T10:00:00.000Z',
    });
    expect(mockUpsertEntitlement).not.toHaveBeenCalled();
  });

  it('does not blindly upsert when the Solidgate main RPC rejects an older order', async () => {
    arrangeSolidgateMainClaim();
    mockAdminRpc.mockResolvedValue({ data: false, error: null });

    const res = await postRoute();

    expect(res.status).toBe(200);
    expect(mockAdminRpc).toHaveBeenCalledOnce();
    expect(mockUpsertEntitlement).not.toHaveBeenCalled();
  });

  // A row that is NOT the Solidgate main subscription (different PSP, or a
  // product the main-entitlement RPC does not own) must still fall through to
  // the generic name→slug upsert path.
  it('preserves the generic entitlement backfill for non-main orders', async () => {
    arrangeSolidgateMainClaim();
    ordersSelectIn.mockResolvedValue({
      data: [{
        id: 'other-order-id',
        psp: 'legacy',
        product_name: 'Demo Trial',
        product_slug: null,
        status: 'completed',
        created_at: '2026-07-21T10:00:00.000Z',
        amount_cents: 1300,
        solidgate_original_amount_cents: null,
        solidgate_subscription_id: null,
      }],
      error: null,
    });

    const res = await postRoute();

    expect(res.status).toBe(200);
    expect(mockAdminRpc).not.toHaveBeenCalled();
    expect(mockUpsertEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-claim-id',
      orderId: 'other-order-id',
      productSlug: 'trial1',
      source: 'claim',
      paymentEnvironment: 'sandbox',
    }));
  });
});
