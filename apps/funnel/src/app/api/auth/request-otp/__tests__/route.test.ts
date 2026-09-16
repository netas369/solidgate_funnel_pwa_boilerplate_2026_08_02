import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

// The route delegates entirely to handleRequestOtp() in
// @repo/shared/auth/request-otp. handleRequestOtp:
//   1. normalizes + validates the email,
//   2. calls supabase.auth.signInWithOtp({ email, options:{ shouldCreateUser:false } }),
//   3. on success → generic 200,
//   4. on a 429 → throttled 429,
//   5. on a "missing user" OTP error → paid-buyer self-heal branch (admin client),
//   6. on any other OTP error → 500.

const signInWithOtp = vi.fn();
const sendWelcomeEmail = vi.fn();
const originalVercelEnvironment = process.env.VERCEL_ENV;

// ─── Admin client: sessions self-heal lookup + createUser/listUsers ──────────
// Only exercised by the self-heal branch (missing-user OTP error + paid order).
const sessionsLimit = vi.fn();
const sessionsSelectEq = vi.fn();
const sessionsSelectChain = { eq: sessionsSelectEq, limit: sessionsLimit };
sessionsSelectEq.mockImplementation(() => sessionsSelectChain);
const sessionsSelect = vi.fn(() => sessionsSelectChain);

const sessionsUpdateIs = vi.fn();
const sessionsUpdateEq = vi.fn(() => ({ is: sessionsUpdateIs }));
const sessionsUpdate = vi.fn(() => ({ eq: sessionsUpdateEq }));

const ordersUpdateIs = vi.fn();
const ordersUpdateEq = vi.fn();
const ordersUpdateIn = vi.fn();
const ordersUpdateChain = {
  eq: ordersUpdateEq,
  in: ordersUpdateIn,
  is: ordersUpdateIs,
};
ordersUpdateEq.mockImplementation(() => ordersUpdateChain);
ordersUpdateIn.mockImplementation(() => ordersUpdateChain);
const ordersUpdate = vi.fn(() => ordersUpdateChain);

const createUser = vi.fn();
const listUsers = vi.fn();

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithOtp,
    },
  })),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser,
        listUsers,
      },
    },
    from: vi.fn((table: string) => {
      if (table === 'orders') {
        return { update: ordersUpdate };
      }
      // sessions table
      return { select: sessionsSelect, update: sessionsUpdate };
    }),
  })),
}));

// Welcome email is a best-effort side-effect of the self-heal branch.
vi.mock('@repo/shared/email/send-welcome-email', () => ({
  sendWelcomeEmail,
}));

async function postRoute(body: unknown) {
  const { POST } = await import('../route');

  return POST(
    new Request('http://localhost/api/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/auth/request-otp', () => {
  const genericResponse = {
    ok: true,
    message: `If that email is linked to a ${BOILERPLATE_BRAND.name} account, check your inbox for a 6-digit code.`,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.VERCEL_ENV = 'preview';
    signInWithOtp.mockReset();
    sendWelcomeEmail.mockReset().mockResolvedValue(undefined);
    sessionsLimit.mockReset();
    sessionsSelectEq.mockClear();
    sessionsSelectEq.mockImplementation(() => sessionsSelectChain);
    sessionsSelect.mockClear();
    sessionsUpdateIs.mockReset();
    sessionsUpdateEq.mockClear();
    sessionsUpdate.mockClear();
    ordersUpdateIs.mockReset();
    ordersUpdateEq.mockClear();
    ordersUpdateEq.mockImplementation(() => ordersUpdateChain);
    ordersUpdateIn.mockClear();
    ordersUpdateIn.mockImplementation(() => ordersUpdateChain);
    ordersUpdate.mockClear();
    createUser.mockReset();
    listUsers.mockReset();

    // Sensible defaults so the self-heal chain never throws if reached.
    sessionsLimit.mockResolvedValue({ data: [], error: null });
    sessionsUpdateIs.mockResolvedValue({ error: null });
    ordersUpdateIs.mockResolvedValue({ error: null });
    listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  });

  afterAll(() => {
    if (originalVercelEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnvironment;
  });

  it('requests an OTP with shouldCreateUser:false and returns a generic 200 response', async () => {
    signInWithOtp.mockResolvedValue({ error: null });

    const res = await postRoute({ email: 'Buyer@Example.com ' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(genericResponse);
    // Email is trimmed + lowercased before the Supabase call.
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      options: { shouldCreateUser: false },
    });
  });

  it('returns the same generic 200 response for an unknown email', async () => {
    // shouldCreateUser:false → Supabase silently ignores unknown emails and
    // returns no error, so the handler still emits the generic success.
    signInWithOtp.mockResolvedValue({ error: null });

    const res = await postRoute({ email: 'unknown@example.com' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(genericResponse);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'unknown@example.com',
      options: { shouldCreateUser: false },
    });
  });

  it('rejects a malformed email with a 400 before calling Supabase', async () => {
    const res = await postRoute({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Valid email is required' });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('returns 429 with the retry-after seconds when Supabase rate-limits', async () => {
    signInWithOtp.mockResolvedValue({
      error: { status: 429, message: 'For security purposes, you can only request this after 47 seconds.' },
    });

    const res = await postRoute({ email: 'buyer@example.com' });

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: 'Please wait 47 seconds before requesting a new code.',
    });
  });

  it('returns 500 on a generic (non-missing-user) OTP error', async () => {
    signInWithOtp.mockResolvedValue({
      error: { status: 500, message: 'Internal Supabase failure' },
    });

    const res = await postRoute({ email: 'buyer@example.com' });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to request code' });
  });

  it('self-heals a paid buyer with no auth user: creates the user, backfills, and returns generic 200', async () => {
    // First OTP attempt fails because no auth user exists (shouldCreateUser:false).
    signInWithOtp
      .mockResolvedValueOnce({
        error: { status: 422, message: 'Signups not allowed for otp' },
      })
      // Retry after self-heal created the user succeeds.
      .mockResolvedValueOnce({ error: null });
    // The email is tied to a session with a completed order.
    sessionsLimit.mockResolvedValue({
      data: [{ id: 'session-1', email: 'purchaser@example.com', user_id: null, locale: 'en' }],
      error: null,
    });
    createUser.mockResolvedValue({
      data: { user: { id: 'user-new-1' } },
      error: null,
    });

    const res = await postRoute({ email: 'purchaser@example.com' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(genericResponse);
    // Self-heal created the auth user and backfilled the linkage.
    expect(createUser).toHaveBeenCalledWith({
      email: 'purchaser@example.com',
      email_confirm: false,
    });
    expect(sessionsUpdate).toHaveBeenCalledWith({ user_id: 'user-new-1' });
    expect(ordersUpdate).toHaveBeenCalledWith({ user_id: 'user-new-1' });
    // Preview self-heal may repair isolated DB ownership, but must not send a
    // real customer welcome email from a sandbox transaction.
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
    // OTP send was retried once the user existed.
    expect(signInWithOtp).toHaveBeenCalledTimes(2);
  });

  it('returns generic 200 without self-healing when the missing-user email has no paid order', async () => {
    signInWithOtp.mockResolvedValue({
      error: { status: 400, message: 'Signups not allowed for otp' },
    });
    // No completed order for this email.
    sessionsLimit.mockResolvedValue({ data: [], error: null });

    const res = await postRoute({ email: 'noorder@example.com' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(genericResponse);
    // No account is created when there is no paid order (no account-existence leak).
    expect(createUser).not.toHaveBeenCalled();
    // OTP send is not retried.
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  });
});
