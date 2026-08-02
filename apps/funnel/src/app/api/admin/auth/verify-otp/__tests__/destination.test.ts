import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks for the dependencies the admin verify-otp route imports.
const {
  mockHandleVerifyOtp,
  mockCreateClient,
  mockIsAdminEmail,
  mockCheckRateLimit,
  mockRecordAttempt,
  mockGetUser,
} = vi.hoisted(() => ({
  mockHandleVerifyOtp: vi.fn(),
  mockCreateClient: vi.fn(),
  mockIsAdminEmail: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRecordAttempt: vi.fn(),
  mockGetUser: vi.fn(),
}));

vi.mock('@repo/shared/auth/verify-otp', () => ({
  handleVerifyOtp: mockHandleVerifyOtp,
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: mockCreateClient,
}));

vi.mock('@/app/admin/_queries/_shared', () => ({
  isAdminEmail: mockIsAdminEmail,
}));

vi.mock('@repo/shared/auth/otp-rate-limit', () => ({
  checkOtpRateLimit: mockCheckRateLimit,
  recordOtpAttempt: mockRecordAttempt,
}));

describe('POST /api/admin/auth/verify-otp (getRedirectUrl logic)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: mockGetUser },
    });
  });

  it('getRedirectUrl returns /admin/dashboard when isAdminEmail returns true', async () => {
    // Capture the options object the route passes into handleVerifyOtp so we
    // can drive getRedirectUrl(userId) directly.
    let capturedOptions:
      | {
          getRedirectUrl: (userId: string) => Promise<string>;
        }
      | null = null;
    mockHandleVerifyOtp.mockImplementation(
      async (_req: Request, opts: { getRedirectUrl: (id: string) => Promise<string> }) => {
        capturedOptions = opts as typeof capturedOptions;
        return new Response(null, { status: 200 });
      },
    );

    const { POST } = await import('../route');
    await POST(
      new Request('https://example.com/api/admin/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', token: '123456' }),
      }),
    );

    expect(capturedOptions).not.toBeNull();
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-42', email: 'admin@example.com' } },
    });
    mockIsAdminEmail.mockReturnValueOnce(true);

    const redirect = await capturedOptions!.getRedirectUrl('user-42');
    expect(redirect).toBe('/admin/dashboard');
  });

  it('getRedirectUrl returns / when isAdminEmail returns false', async () => {
    let capturedOptions:
      | {
          getRedirectUrl: (userId: string) => Promise<string>;
        }
      | null = null;
    mockHandleVerifyOtp.mockImplementation(
      async (_req: Request, opts: { getRedirectUrl: (id: string) => Promise<string> }) => {
        capturedOptions = opts as typeof capturedOptions;
        return new Response(null, { status: 200 });
      },
    );

    const { POST } = await import('../route');
    await POST(
      new Request('https://example.com/api/admin/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: 'bob@example.com', token: '123456' }),
      }),
    );

    expect(capturedOptions).not.toBeNull();
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-789', email: 'bob@example.com' } },
    });
    mockIsAdminEmail.mockReturnValueOnce(false);

    const redirect = await capturedOptions!.getRedirectUrl('user-789');
    expect(redirect).toBe('/');
  });

  it('getRedirectUrl returns / when no user is present', async () => {
    let capturedOptions:
      | {
          getRedirectUrl: (userId: string) => Promise<string>;
        }
      | null = null;
    mockHandleVerifyOtp.mockImplementation(
      async (_req: Request, opts: { getRedirectUrl: (id: string) => Promise<string> }) => {
        capturedOptions = opts as typeof capturedOptions;
        return new Response(null, { status: 200 });
      },
    );

    const { POST } = await import('../route');
    await POST(
      new Request('https://example.com/api/admin/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: 'x@example.com', token: '123456' }),
      }),
    );

    mockGetUser.mockResolvedValueOnce({ data: { user: null } });

    const redirect = await capturedOptions!.getRedirectUrl('user-xxx');
    expect(redirect).toBe('/');
  });
});
