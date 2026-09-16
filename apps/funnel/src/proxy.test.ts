import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  verifyPaymentCookie,
  verifySolidgateMainAcceptedCookie,
  createServerClient,
  mockUpdateSession,
  mockAuthGetUser,
  mockOrdersSelect,
  mockOrdersEqEnvironment,
  mockOrdersEqUserId,
  mockOrdersEqStatus,
  mockOrdersLimit,
  mockOrdersMaybeSingle,
  mockOrdersEqPaymentOrderId,
  mockOrdersEqSessionId,
  mockAdminFrom,
  mockAdminOrdersSelect,
  mockAdminOrdersEq,
  mockAdminOrdersMaybeSingle,
} = vi.hoisted(() => ({
  verifyPaymentCookie: vi.fn(),
  verifySolidgateMainAcceptedCookie: vi.fn(),
  createServerClient: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockAuthGetUser: vi.fn(),
  mockOrdersSelect: vi.fn(),
  mockOrdersEqEnvironment: vi.fn(),
  mockOrdersEqUserId: vi.fn(),
  mockOrdersEqStatus: vi.fn(),
  mockOrdersLimit: vi.fn(),
  mockOrdersMaybeSingle: vi.fn(),
  mockOrdersEqPaymentOrderId: vi.fn(),
  mockOrdersEqSessionId: vi.fn(),
  mockAdminFrom: vi.fn(),
  mockAdminOrdersSelect: vi.fn(),
  mockAdminOrdersEq: vi.fn(),
  mockAdminOrdersMaybeSingle: vi.fn(),
}));

vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
  verifyPaymentCookie,
}));

vi.mock('@repo/shared/solidgate/main-accepted-cookie', () => ({
  SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME: 'solidgate_main_accepted',
  verifySolidgateMainAcceptedCookie,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient,
}));

vi.mock('@repo/shared/supabase/middleware', () => ({
  updateSession: mockUpdateSession,
}));

// next-intl middleware  -  return a non-redirect Response so proxy continues.
// Tracked via mockIntlInstance so Plan-01 admin tests can assert it is NOT
// invoked for /admin/* requests (D-08 — intl bypassed for admin tree).
const mockIntlInstance = vi.fn(() => new Response(null, { status: 200, headers: new Headers() }));
vi.mock('next-intl/middleware', () => ({
  default: vi.fn(() => mockIntlInstance),
}));

vi.mock('@repo/i18n/routing', () => ({
  routing: { locales: ['en', 'lt'], defaultLocale: 'en' },
  LOCALE_URL_PREFIX: { en: 'en', lt: 'lt' },
}));

// Admin client for anonymous /oto/* DB verification path
vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: mockAdminFrom,
  })),
}));

// Env vars needed by createServerClient in proxy
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VERCEL_ENV = 'preview';
// Plan-01 Wave-0: admin allowlist env for the /admin branch tests below.
process.env.ADMIN_EMAILS = 'admin@example.com';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const ORDER_ID = `${SESSION_ID}:trial1:1`;
const MAIN_PRODUCT_CODE = 'BRAND_000000_SUB';

function canonicalAcceptedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-db-id',
    payment_environment: 'sandbox',
    solidgate_order_id: ORDER_ID,
    session_id: SESSION_ID,
    psp: 'solidgate',
    product_name: MAIN_PRODUCT_CODE,
    product_slug: MAIN_PRODUCT_CODE,
    amount_cents: 500,
    currency: 'eur',
    status: 'pending',
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'main',
      session_id: SESSION_ID,
      product_slug: 'trial1',
      price_id: 'solidgate:trial1:eur',
    },
    solidgate_subscription_id: 'sub_accepted',
    solidgate_payment_status: 'auth_ok',
    solidgate_original_amount_cents: 500,
    solidgate_refunded_amount_cents: 0,
    solidgate_chargeback_id: null,
    solidgate_chargeback_status: null,
    solidgate_chargeback_amount_cents: 0,
    solidgate_customer_email: 'buyer@example.com',
    solidgate_checkout_locale: 'en',
    solidgate_product_id: 'product-main-eur',
    solidgate_payment_action: 'auth_settle',
    solidgate_checkout_identity_legacy: false,
    ...overrides,
  };
}

describe('proxy paid-route guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUpdateSession.mockResolvedValue(new Response(null, { status: 200 }));
    verifyPaymentCookie.mockResolvedValue(null);
    verifySolidgateMainAcceptedCookie.mockResolvedValue(null);

    const adminQuery = {
      select: mockAdminOrdersSelect,
      eq: mockAdminOrdersEq,
      maybeSingle: mockAdminOrdersMaybeSingle,
    };
    mockAdminFrom.mockReturnValue(adminQuery);
    mockAdminOrdersSelect.mockReturnValue(adminQuery);
    mockAdminOrdersEq.mockReturnValue(adminQuery);
    mockOrdersEqStatus.mockReturnValue({
      limit: mockOrdersLimit,
    });
    mockOrdersLimit.mockReturnValue({
      maybeSingle: mockOrdersMaybeSingle,
    });
    mockOrdersEqUserId.mockReturnValue({
      eq: mockOrdersEqStatus,
    });
    mockOrdersEqSessionId.mockReturnValue({
      maybeSingle: mockOrdersMaybeSingle,
    });
    mockOrdersEqPaymentOrderId.mockReturnValue({
      eq: mockOrdersEqSessionId,
    });
    mockOrdersEqEnvironment.mockReturnValue({
      eq: mockOrdersEqUserId,
    });
    mockOrdersSelect.mockReturnValue({
      eq: vi.fn((column: string, value: string) => {
        if (column === 'payment_environment') {
          return mockOrdersEqEnvironment(column, value);
        }

        throw new Error(`Unexpected eq column: ${column}`);
      }),
    });

    createServerClient.mockReturnValue({
      auth: {
        getUser: mockAuthGetUser,
      },
      from: vi.fn((table: string) => {
        if (table !== 'orders') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select: mockOrdersSelect,
        };
      }),
    });
  });

  it('authenticated paid users redirect from /offer to /dashboard', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({
      data: { id: 'order-1' },
    });

    const response = await proxy(new NextRequest('https://example.com/offer'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/dashboard');
  });

  it('authenticated paid users can access /oto/1 without cookie (Phase 1004 cross-device)', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({
      data: { id: 'order-1' },
    });

    const response = await proxy(new NextRequest('https://example.com/oto/1'));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
  });

  it('authenticated paid users can access /success without redirect', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({
      data: { id: 'order-1' },
    });

    const response = await proxy(new NextRequest('https://example.com/success'));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
  });

  it('allows authenticated paid users to reach /oto/* when a verified payment_access cookie is present', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({
      data: { id: 'order-1' },
    });
    verifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_123',
      sessionId: 'session-123',
    });

    const response = await proxy(
      new NextRequest('https://example.com/oto/1', {
        headers: {
          cookie: 'payment_access=signed-cookie',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
  });

  it('authenticated users without completed orders can still reach /offer', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({
      data: null,
    });

    const response = await proxy(new NextRequest('https://example.com/offer'));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
  });

  it('redirects authenticated users without payment proof away from OTO pages', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({ data: null });

    const response = await proxy(new NextRequest('https://example.com/oto/1'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
  });

  it('allows an authenticated user without a completed cross-device order only with exact payment proof', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-123' } },
    });
    mockOrdersMaybeSingle.mockResolvedValue({ data: null });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      paymentIntentId: ORDER_ID,
      sessionId: SESSION_ID,
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({ data: { id: 'order-db-id' }, error: null });

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'payment_access=signed-payment-cookie' },
    }));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
  });

  it('anonymous /oto/* requests without a verified payment_access cookie still redirect to /offer', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: null },
    });
    verifyPaymentCookie.mockResolvedValue(null);

    const response = await proxy(new NextRequest('https://example.com/oto/1'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
  });

  it('anonymous /oto/* access still requires a verified payment_access cookie bound to the order session', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: null },
    });
    verifyPaymentCookie.mockResolvedValue({
      paymentIntentId: 'pi_123',
      sessionId: 'session-123',
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({
      data: null,
    });

    const request = new NextRequest('https://example.com/oto/1', {
      headers: {
        cookie: 'payment_access=signed-cookie',
      },
    });
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
    expect(verifyPaymentCookie).toHaveBeenCalledWith('signed-cookie');
  });

  it('admits anonymous /oto/1 with an exact canonical paid auth_ok cookie binding', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({
      data: canonicalAcceptedOrder(),
      error: null,
    });

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
    expect(verifySolidgateMainAcceptedCookie).toHaveBeenCalledWith('signed-accepted-cookie');
    expect(mockAdminOrdersEq).toHaveBeenCalledWith('payment_environment', 'sandbox');
    expect(mockAdminOrdersEq).toHaveBeenCalledWith('solidgate_order_id', ORDER_ID);
    expect(mockAdminOrdersEq).toHaveBeenCalledWith('session_id', SESSION_ID);
  });

  it('admits a localized /oto/1 path with the same canonical provisional binding', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({
      data: canonicalAcceptedOrder(),
      error: null,
    });

    const response = await proxy(new NextRequest('https://example.com/lt/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(200);
  });

  it('redirects a valid provisional cookie from later OTO routes back to /oto/1', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });

    const response = await proxy(new NextRequest('https://example.com/oto/2', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/oto/1');
    expect(mockAdminOrdersMaybeSingle).not.toHaveBeenCalled();
  });

  it('does not consult the provisional cookie outside OTO routes', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });

    const response = await proxy(new NextRequest('https://example.com/success', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(200);
    expect(verifySolidgateMainAcceptedCookie).not.toHaveBeenCalled();
  });

  it('rejects an invalid or expired provisional cookie', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue(null);

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=invalid-cookie' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
    expect(mockAdminOrdersMaybeSingle).not.toHaveBeenCalled();
  });

  it('rejects a provisional cookie issued for another payment environment', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'production',
    });

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=production-cookie' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
    expect(mockAdminOrdersMaybeSingle).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong environment row', { payment_environment: 'production' }],
    ['foreign product', { product_slug: 'BRANDLIFETIME_000000_SUB' }],
    ['unaccepted provider state', { solidgate_payment_status: 'processing' }],
    ['failed order', { status: 'failed' }],
    ['missing subscription binding', { solidgate_subscription_id: null }],
    ['refunded order', { solidgate_refunded_amount_cents: 100, amount_cents: 400 }],
    ['chargeback order', { solidgate_chargeback_id: 'cb_1', solidgate_chargeback_amount_cents: 500 }],
    ['legacy checkout identity', { solidgate_checkout_identity_legacy: true }],
  ])('rejects a canonical mismatch: %s', async (_label, overrides) => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({
      data: canonicalAcceptedOrder(overrides),
      error: null,
    });

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/offer');
  });

  it.each([
    ['settled', 'trialing', 'settle_ok'],
    ['fully captured partial settlement', 'active', 'partial_settled'],
  ])('admits a webhook-captured race: %s', async (_label, status, paymentStatus) => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifySolidgateMainAcceptedCookie.mockResolvedValue({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({
      data: canonicalAcceptedOrder({
        status,
        solidgate_payment_status: paymentStatus,
      }),
      error: null,
    });

    const response = await proxy(new NextRequest('https://example.com/oto/1', {
      headers: { cookie: 'solidgate_main_accepted=signed-accepted-cookie' },
    }));

    expect(response.status).toBe(200);
  });

  it('still allows a fully verified payment_access cookie on later OTO routes', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });
    verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      paymentIntentId: ORDER_ID,
      sessionId: SESSION_ID,
    });
    mockAdminOrdersMaybeSingle.mockResolvedValue({ data: { id: 'order-db-id' }, error: null });

    const response = await proxy(new NextRequest('https://example.com/oto/2', {
      headers: { cookie: 'payment_access=signed-payment-cookie' },
    }));

    expect(response.status).toBe(200);
  });
});

describe('proxy public documentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateSession.mockResolvedValue(new Response(null, { status: 200 }));
  });

  it.each([
    '/documentation',
    '/documentation/',
    '/documentation/payments',
    '/documentation/payments/renewals?view=diagram',
  ])('serves %s without locale, auth, or payment lookups', async (path) => {
    const { proxy } = await import('./proxy');
    const response = await proxy(new NextRequest(`https://example.com${path}`, {
      headers: {
        'x-vercel-ip-country': 'LT',
        'accept-language': 'lt-LT,lt;q=0.9',
        cookie: 'NEXT_LOCALE=lt; payment_access=irrelevant-cookie',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('location')).toBeNull();
    expect(mockIntlInstance).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(createServerClient).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(verifyPaymentCookie).not.toHaveBeenCalled();
    expect(verifySolidgateMainAcceptedCookie).not.toHaveBeenCalled();
  });

  it.each(['/documentation-ish', '/documentation2', '/documentation-private/overview'])(
    'keeps normal routing for the neighboring path %s',
    async (path) => {
      const { proxy } = await import('./proxy');

      const response = await proxy(new NextRequest(`https://example.com${path}`));

      expect(response.status).toBe(200);
      expect(mockIntlInstance).toHaveBeenCalledOnce();
      expect(mockUpdateSession).toHaveBeenCalledOnce();
    },
  );
});

describe('proxy /admin branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADMIN_EMAILS = 'admin@example.com';

    mockUpdateSession.mockResolvedValue(new Response(null, { status: 200 }));

    // createServerClient: minimal auth surface — admin branch only reads getUser.
    createServerClient.mockReturnValue({
      auth: {
        getUser: mockAuthGetUser,
      },
      from: vi.fn(() => {
        throw new Error('admin branch must not query tables');
      }),
    });
  });

  it('login publicly reachable without auth', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });

    const response = await proxy(new NextRequest('https://example.com/admin/login'));

    // Must NOT redirect: should pass through to updateSession.
    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
    // Intl middleware MUST NOT be invoked for /admin/*.
    expect(mockIntlInstance).not.toHaveBeenCalled();
  });

  it('unauthenticated /admin/dashboard redirects to /', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({ data: { user: null } });

    const response = await proxy(new NextRequest('https://example.com/admin/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/');
    expect(mockIntlInstance).not.toHaveBeenCalled();
  });

  it('authenticated non-admin redirects to / silently', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-789', email: 'bob@example.com' } },
    });

    const response = await proxy(new NextRequest('https://example.com/admin/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.com/');
    expect(mockIntlInstance).not.toHaveBeenCalled();
  });

  it('authenticated allowlisted user passes through to updateSession', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-42', email: 'admin@example.com' } },
    });

    const response = await proxy(new NextRequest('https://example.com/admin/dashboard'));

    expect(response.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledOnce();
    expect(mockIntlInstance).not.toHaveBeenCalled();
  });

  it('intl middleware is bypassed for /admin/* paths', async () => {
    const { proxy } = await import('./proxy');

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: 'user-42', email: 'admin@example.com' } },
    });

    await proxy(new NextRequest('https://example.com/admin/anything'));
    await proxy(new NextRequest('https://example.com/admin/dashboard'));
    await proxy(new NextRequest('https://example.com/admin/login'));

    // Across three /admin/* requests, intl middleware was never called.
    expect(mockIntlInstance).not.toHaveBeenCalled();
  });
});
