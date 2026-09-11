import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks for the two dependencies the admin request-otp route imports.
const { mockHandleRequestOtp, mockIsAdminEmail, mockConsumeRateLimit } = vi.hoisted(() => ({
  mockHandleRequestOtp: vi.fn(),
  mockIsAdminEmail: vi.fn(),
  mockConsumeRateLimit: vi.fn(),
}));

vi.mock('@repo/shared/auth/request-otp', () => ({
  handleRequestOtp: mockHandleRequestOtp,
}));

vi.mock('@/app/admin/_queries/_shared', () => ({
  isAdminEmail: mockIsAdminEmail,
}));

vi.mock('@/features/admin/rate-limit', () => ({
  consumeAdminRateLimit: mockConsumeRateLimit,
}));

describe('POST /api/admin/auth/request-otp (allowlist pre-send filter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumeRateLimit.mockResolvedValue({ allowed: true });
  });

  it('non-allowlisted email returns generic success without calling handleRequestOtp', async () => {
    mockIsAdminEmail.mockReturnValue(false);

    const { POST } = await import('../route');
    const request = new Request('https://example.com/api/admin/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ email: 'attacker@example.com' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/admin allowlist/i);
    expect(mockHandleRequestOtp).not.toHaveBeenCalled();
  });

  it('allowlisted email delegates to handleRequestOtp', async () => {
    mockIsAdminEmail.mockReturnValue(true);
    mockHandleRequestOtp.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { POST } = await import('../route');
    const request = new Request('https://example.com/api/admin/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ email: 'admin@example.com' }),
    });

    const response = await POST(request);
    expect(mockHandleRequestOtp).toHaveBeenCalledOnce();
    expect(mockConsumeRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'admin@example.com', scope: 'admin_otp_request' }),
    );
    expect(response.status).toBe(200);
  });

  it('missing email returns generic success without calling handleRequestOtp', async () => {
    mockIsAdminEmail.mockReturnValue(false);

    const { POST } = await import('../route');
    const request = new Request('https://example.com/api/admin/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: '{}',
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockHandleRequestOtp).not.toHaveBeenCalled();
  });

  it('rejects cross-site requests and does not send when throttling fails closed', async () => {
    mockIsAdminEmail.mockReturnValue(true);
    const { POST } = await import('../route');
    const crossSite = new Request('https://example.com/api/admin/auth/request-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ email: 'admin@example.com' }),
    });
    expect((await POST(crossSite)).status).toBe(400);

    mockConsumeRateLimit.mockResolvedValue({ allowed: false, unavailable: true });
    const throttled = new Request('https://example.com/api/admin/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: JSON.stringify({ email: 'admin@example.com' }),
    });
    expect((await POST(throttled)).status).toBe(200);
    expect(mockHandleRequestOtp).not.toHaveBeenCalled();
  });
});
