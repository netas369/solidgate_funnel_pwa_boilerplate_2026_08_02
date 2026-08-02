import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionMaybeSingle: vi.fn(),
  authorize: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'sessions') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mocks.sessionMaybeSingle }),
        }),
      };
    },
    rpc: mocks.rpc,
  }),
}));

vi.mock('@/lib/payment/solidgate-access', () => ({
  authorizeSolidgateSession: mocks.authorize,
}));

const { POST } = await import('../route');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function post(body: unknown) {
  return POST(new Request('http://localhost/api/solidgate/advance-oto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/solidgate/advance-oto', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VERCEL_ENV;
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { user_id: 'user-1' },
      error: null,
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      userId: 'user-1',
      vault: { cardToken: 'card-token', customerAccountId: 'customer-1' },
    });
    mocks.rpc.mockResolvedValue({
      data: [{ persisted_step: 4, advanced: true, conflict: false }],
      error: null,
    });
  });

  it.each([
    { sessionId: 'not-a-uuid', currentStep: 1 },
    { sessionId: SESSION_ID, currentStep: 0 },
    { sessionId: SESSION_ID, currentStep: 8 },
    { sessionId: SESSION_ID, currentStep: 2.5 },
    { sessionId: SESSION_ID, currentStep: '2' },
  ])('rejects malformed session/step input before database access: %o', async (body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mocks.sessionMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('returns 404 for a session that does not exist', async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({ data: null, error: null });

    const response = await post({ sessionId: SESSION_ID, currentStep: 1 });

    expect(response.status).toBe(404);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('uses the existing session-bound payment authorization and forwards denial', async () => {
    mocks.authorize.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 2 });

    expect(response.status).toBe(403);
    expect(mocks.authorize).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
      requireCardToken: false,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('derives progress server-side and never accepts browser catch-up authority or a next URL', async () => {
    const response = await post({
      sessionId: SESSION_ID,
      currentStep: 3,
      nextOto: '/oto/8',
      allowCatchUp: true,
    });

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('advance_solidgate_oto_progress', {
      p_payment_environment: 'sandbox',
      p_session_id: SESSION_ID,
      p_current_step: 3,
      p_allow_catch_up: false,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      advanced: true,
      lastOtoStep: '4',
      resumeTo: '/oto/4',
    });
  });

  it('keeps a later winning checkpoint on delayed duplicate requests', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ persisted_step: 6, advanced: false, conflict: false }],
      error: null,
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 2 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      advanced: false,
      lastOtoStep: '6',
      resumeTo: '/oto/6',
    });
  });

  it('returns a conflict when a skip attempts to jump over the durable current step', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ persisted_step: 2, advanced: false, conflict: true }],
      error: null,
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 5 });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'progress_conflict',
      lastOtoStep: '2',
      resumeTo: '/oto/2',
    });
  });

  it('fails closed when a sandbox session is reused in another payment environment', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'oto_progress_environment_mismatch' },
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 3 });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'progress_conflict',
    });
  });

  it('allows identity-authorized progress without requiring a saved card token', async () => {
    mocks.authorize.mockResolvedValue({
      ok: true,
      userId: 'user-1',
      vault: null,
      resolvedVia: 'account',
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 3 });

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
      requireCardToken: false,
    });
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });

  it('fails closed when the RPC returns a non-allowlisted checkpoint', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ persisted_step: 9, advanced: true, conflict: false }],
      error: null,
    });

    const response = await post({ sessionId: SESSION_ID, currentStep: 7 });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Failed to persist OTO progress',
    });
  });
});
