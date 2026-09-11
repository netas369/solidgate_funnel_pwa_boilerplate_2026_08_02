import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAdmin: vi.fn(),
  getAdminClient: vi.fn(),
  rpc: vi.fn(),
  getUserById: vi.fn(),
  auditInsert: vi.fn(),
  auditSelect: vi.fn(),
  auditSingle: vi.fn(),
  auditUpdate: vi.fn(),
  auditEq: vi.fn(),
  signInWithOtp: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('@/app/admin/_queries/admin-access', () => ({
  getAuthenticatedAdminUser: mocks.getAdmin,
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: mocks.getAdminClient,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithOtp: mocks.signInWithOtp } }),
}));

vi.mock('@/features/admin/rate-limit', () => ({
  consumeAdminRateLimit: mocks.consumeRateLimit,
}));

import { POST } from '../route';

function request(body: unknown, origin = 'https://example.test') {
  const safeBody =
    body && typeof body === 'object' && !Array.isArray(body)
      ? {
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
          ...(body as Record<string, unknown>),
        }
      : body;
  return new Request('https://example.test/api/admin/support/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(safeBody),
  });
}

describe('POST /api/admin/support/actions', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.getAdmin.mockResolvedValue({ id: 'admin-id' });
    mocks.getAdminClient.mockReturnValue({
      rpc: mocks.rpc,
      auth: { admin: { getUserById: mocks.getUserById } },
      from: () => ({
        insert: mocks.auditInsert,
        update: mocks.auditUpdate,
      }),
    });
    mocks.rpc.mockResolvedValue({ data: 'customer-id', error: null });
    mocks.getUserById.mockResolvedValue({
      data: { user: { id: 'customer-id', email: 'customer@example.com' } },
      error: null,
    });
    mocks.auditInsert.mockReturnValue({ select: mocks.auditSelect });
    mocks.auditSelect.mockReturnValue({ single: mocks.auditSingle });
    mocks.auditSingle.mockResolvedValue({ data: { id: 'audit-id' }, error: null });
    mocks.auditUpdate.mockReturnValue({ eq: mocks.auditEq });
    mocks.auditEq.mockResolvedValue({ error: null });
    mocks.signInWithOtp.mockResolvedValue({ error: null });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  });

  it('rejects unauthenticated and cross-origin mutations before data access', async () => {
    mocks.getAdmin.mockResolvedValueOnce(null);
    expect((await POST(request({ action: 'send_login_code', email: 'customer@example.com', confirm: true }))).status).toBe(401);

    expect((await POST(request({ action: 'send_login_code', email: 'customer@example.com', confirm: true }, 'https://attacker.test'))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('audits before sending a login code to the resolved account', async () => {
    const response = await POST(request({
      action: 'send_login_code',
      email: 'Customer@Example.com',
      confirm: true,
    }));

    expect(response.status).toBe(200);
    expect(mocks.auditInsert).toHaveBeenCalledBefore(mocks.signInWithOtp);
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: 'customer@example.com',
      options: { shouldCreateUser: false },
    });
    expect(mocks.auditUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'success' }),
    );
  });

  it('audits and refuses revoking the current administrator', async () => {
    mocks.getAdmin.mockResolvedValue({ id: 'customer-id' });
    const response = await POST(request({
      action: 'revoke_sessions',
      email: 'customer@example.com',
      confirm: true,
    }));

    expect(response.status).toBe(409);
    expect(mocks.auditUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'refused', details: { reason: 'self_revocation' } }),
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('requires an idempotency key and rate-limits before resolving the customer', async () => {
    const missingKey = new Request('https://example.test/api/admin/support/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' },
      body: JSON.stringify({
        action: 'send_login_code',
        email: 'customer@example.com',
        confirm: true,
      }),
    });
    expect((await POST(missingKey)).status).toBe(400);

    mocks.consumeRateLimit.mockResolvedValue({ allowed: false, unavailable: false });
    expect((await POST(request({
      action: 'send_login_code',
      email: 'customer@example.com',
      confirm: true,
    }))).status).toBe(429);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
