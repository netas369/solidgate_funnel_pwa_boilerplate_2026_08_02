import { beforeEach, describe, expect, it, vi } from 'vitest';

const authSignOut = vi.fn();

vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      signOut: authSignOut,
    },
  })),
}));

describe('POST /api/device-reset', () => {
  beforeEach(() => {
    authSignOut.mockReset();
  });

  it('POST /api/device-reset returns a reset contract with redirectTo: /quiz', async () => {
    authSignOut.mockResolvedValue({ error: null });

    const { POST } = await import('@/app/api/device-reset/route');
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, redirectTo: '/' });
  });

  it('POST /api/device-reset signs out auth and expires payment_access', async () => {
    authSignOut.mockResolvedValue({ error: null });

    const { POST } = await import('@/app/api/device-reset/route');
    const response = await POST();
    const cookie = response.cookies.get('payment_access');

    expect(authSignOut).toHaveBeenCalledTimes(1);
    expect(cookie).toMatchObject({
      name: 'payment_access',
      value: '',
      maxAge: 0,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(response.headers.get('set-cookie')).toContain('payment_access=;');
  });

  it('POST /api/device-reset surfaces Failed to reset device state when sign-out fails', async () => {
    authSignOut.mockResolvedValue({ error: { message: 'boom' } });

    const { POST } = await import('@/app/api/device-reset/route');
    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Failed to reset device state' });
  });
});
