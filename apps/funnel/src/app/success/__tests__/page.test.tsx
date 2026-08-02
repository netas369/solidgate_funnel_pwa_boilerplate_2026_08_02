import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRedirect,
  mockGetUser,
  mockSelect,
  mockEqEnvironment,
  mockEq,
  mockIn,
  mockOrder,
  mockSuccessClient,
  mockCookiesGet,
  mockVerifyPaymentCookie,
  mockAdminSelect,
  mockAdminEqEnvironment,
  mockAdminEq,
  mockAdminIn,
  mockAdminOrder,
} = vi.hoisted(() => ({
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  mockGetUser: vi.fn(),
  mockSelect: vi.fn(),
  mockEqEnvironment: vi.fn(),
  mockEq: vi.fn(),
  mockIn: vi.fn(),
  mockOrder: vi.fn(),
  mockSuccessClient: vi.fn(() => <div data-testid="success-client" />),
  mockCookiesGet: vi.fn(),
  mockVerifyPaymentCookie: vi.fn(),
  mockAdminSelect: vi.fn(),
  mockAdminEqEnvironment: vi.fn(),
  mockAdminEq: vi.fn(),
  mockAdminIn: vi.fn(),
  mockAdminOrder: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ get: mockCookiesGet })),
}));

vi.mock('@repo/shared/payment-cookie', () => ({
  verifyPaymentCookie: (...args: unknown[]) => mockVerifyPaymentCookie(...args),
  PAYMENT_COOKIE_NAME: 'payment_access',
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() =>
    Promise.resolve({
      auth: { getUser: mockGetUser },
      from: vi.fn(() => ({
        select: mockSelect,
      })),
    }),
  ),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: mockAdminSelect,
    })),
  })),
}));

vi.mock('@/features/success/components/success-client', () => ({
  SuccessClient: mockSuccessClient,
}));

const mockGetUserEntitlements = vi.fn().mockResolvedValue([]);
vi.mock('@repo/shared/entitlements', () => ({
  getUserEntitlements: (...args: unknown[]) => mockGetUserEntitlements(...args),
}));

describe('SuccessRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCookiesGet.mockReturnValue(undefined);
    mockVerifyPaymentCookie.mockResolvedValue(null);

    mockSelect.mockReturnValue({
      eq: mockEqEnvironment,
    });

    mockEqEnvironment.mockReturnValue({
      eq: mockEq,
    });

    mockEq.mockReturnValue({
      in: mockIn,
    });

    mockIn.mockReturnValue({
      order: mockOrder,
    });

    mockAdminSelect.mockReturnValue({ eq: mockAdminEqEnvironment });
    mockAdminEqEnvironment.mockReturnValue({ eq: mockAdminEq });
    mockAdminEq.mockReturnValue({ in: mockAdminIn });
    mockAdminIn.mockReturnValue({ order: mockAdminOrder });
  });

  it('passes completed and trialing orders into the success summary', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'buyer@example.com' } },
    });

    mockOrder.mockResolvedValue({
      data: [
        {
          id: 'order-completed',
          product_name: 'Main Offer',
          amount_cents: 4700,
          currency: 'eur',
          status: 'completed',
        },
        {
          id: 'order-trialing',
          product_name: 'Weekly Add-on',
          amount_cents: 0,
          currency: 'eur',
          status: 'trialing',
        },
      ],
      error: null,
    });

    const { default: SuccessRoute } = await import('../../[locale]/success/page');
    render(await SuccessRoute());

    expect(mockIn).toHaveBeenCalledWith('status', ['completed', 'trialing']);
    expect(mockSuccessClient).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'buyer@example.com',
        orders: expect.arrayContaining([
          expect.objectContaining({ id: 'order-completed', status: 'completed' }),
          expect.objectContaining({ id: 'order-trialing', status: 'trialing' }),
        ]),
      }),
      undefined,
    );
  });

  it('redirects anonymous visitors without a payment cookie to /offer', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
    });

    const { default: SuccessRoute } = await import('../../[locale]/success/page');
    await SuccessRoute().catch(() => {});

    expect(mockRedirect).toHaveBeenCalledWith('/offer');
  });

  it('loads orders by session_id via payment cookie when no auth session (D-09)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockCookiesGet.mockReturnValue({ value: 'pi_123.sess-id-123.sig' });
    mockVerifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_123',
      sessionId: 'sess-id-123',
    });
    mockAdminOrder.mockResolvedValue({
      data: [
        {
          id: 'order-1',
          product_name: 'Main Offer',
          amount_cents: 4700,
          currency: 'eur',
          status: 'completed',
        },
      ],
      error: null,
    });

    const { default: SuccessRoute } = await import('../../[locale]/success/page');
    render(await SuccessRoute());

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockSuccessClient).toHaveBeenCalledWith(
      expect.objectContaining({
        email: null,
        orders: expect.arrayContaining([expect.objectContaining({ id: 'order-1' })]),
      }),
      undefined,
    );
  });
});
