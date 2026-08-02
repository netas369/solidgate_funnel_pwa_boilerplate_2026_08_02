import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSessionVault: vi.fn(),
  verifyPaymentCookie: vi.fn(),
  orderMaybeSingle: vi.fn(),
  orderQueries: [] as Array<{
    columns: string;
    filters: Array<[string, unknown]>;
  }>,
  cookieValue: null as string | null,
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`);
      let columns = '';
      const filters: Array<[string, unknown]> = [];
      const chain: Record<string, unknown> = {};
      chain.select = (value: string) => {
        columns = value;
        return chain;
      };
      chain.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      };
      chain.maybeSingle = () => {
        const query = { columns, filters: [...filters] };
        mocks.orderQueries.push(query);
        return mocks.orderMaybeSingle(query);
      };
      return chain;
    },
  }),
}));

vi.mock('@repo/shared/solidgate/session-vault', () => ({
  getSessionVault: mocks.getSessionVault,
}));

vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
  verifyPaymentCookie: mocks.verifyPaymentCookie,
}));

vi.mock('@repo/shared/payment-environment', () => ({
  currentPaymentEnvironment: () => 'production',
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => mocks.cookieValue ? { value: mocks.cookieValue } : undefined,
  }),
}));

const { authorizeSolidgateSession } = await import('../solidgate-access');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const SOURCE_ORDER_DB_ID = '11111111-1111-4111-8111-111111111111';
const MAIN_PRODUCT = 'BRAND_000000_SUB';
const MAIN_ORDER_ID = `${SESSION_ID}:trial3:1`;

function mainSource(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ORDER_DB_ID,
    payment_environment: 'production',
    psp: 'solidgate',
    solidgate_order_id: MAIN_ORDER_ID,
    session_id: SESSION_ID,
    user_id: 'user-1',
    product_name: MAIN_PRODUCT,
    product_slug: MAIN_PRODUCT,
    status: 'trialing',
    amount_cents: 500,
    currency: 'eur',
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'main',
      session_id: SESSION_ID,
      product_slug: 'trial3',
      price_id: 'price-main-eur',
    },
    solidgate_original_amount_cents: 500,
    solidgate_payment_status: 'settle_ok',
    solidgate_payment_action: 'auth_settle',
    solidgate_refunded_amount_cents: 0,
    solidgate_chargeback_id: null,
    solidgate_chargeback_status: null,
    solidgate_chargeback_amount_cents: 0,
    solidgate_subscription_id: 'sub-main',
    solidgate_customer_email: 'buyer@example.com',
    solidgate_checkout_locale: 'en',
    solidgate_product_id: 'provider-main-product',
    solidgate_checkout_identity_bound_at: '2026-07-21T10:00:00.000Z',
    solidgate_checkout_identity_legacy: false,
    ...overrides,
  };
}

function sourceBoundVault() {
  return {
    paymentEnvironment: 'production',
    sessionId: SESSION_ID,
    customerAccountId: SESSION_ID,
    sourceOrderId: SOURCE_ORDER_DB_ID,
    cardToken: 'card-token',
    cardOriginalPaymentMethod: 'card',
    cardBrand: 'visa',
    cardLast4: '4242',
  };
}

function signIn(userId = 'user-1') {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: userId } },
    error: null,
  });
}

async function expectNoSavedCard(result: ReturnType<typeof authorizeSolidgateSession>) {
  const access = await result;
  expect(access.ok).toBe(false);
  if (!access.ok) {
    expect(access.response.status).toBe(409);
    await expect(access.response.json()).resolves.toMatchObject({ code: 'no_saved_card' });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orderQueries.length = 0;
  mocks.cookieValue = null;
  mocks.getUser.mockResolvedValue({
    data: { user: null },
    error: { name: 'AuthSessionMissingError' },
  });
  mocks.getSessionVault.mockResolvedValue(null);
  mocks.verifyPaymentCookie.mockResolvedValue(null);
  mocks.orderMaybeSingle.mockResolvedValue({ data: null, error: null });
});

describe('authorizeSolidgateSession', () => {
  it('authorizes a session-linked account for progress without reading the card vault', async () => {
    signIn();

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
      requireCardToken: false,
    })).resolves.toEqual({
      ok: true,
      vault: null,
      userId: 'user-1',
      resolvedVia: 'account',
    });
    expect(mocks.getSessionVault).not.toHaveBeenCalled();
  });

  it('authorizes a valid main-payment cookie for progress without a card token', async () => {
    mocks.cookieValue = 'signed-main-payment';
    mocks.verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: MAIN_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: MAIN_ORDER_ID,
      subscriptionId: null,
    });
    mocks.orderMaybeSingle.mockResolvedValue({ data: { id: SOURCE_ORDER_DB_ID }, error: null });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: null,
      requireCardToken: false,
    })).resolves.toEqual({
      ok: true,
      vault: null,
      userId: null,
      resolvedVia: 'cookie',
    });
    expect(mocks.getSessionVault).not.toHaveBeenCalled();
  });

  it('does not authorize an unauthenticated deep link in identity-only mode', async () => {
    const access = await authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: null,
      requireCardToken: false,
    });

    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.response.status).toBe(401);
    expect(mocks.getSessionVault).not.toHaveBeenCalled();
  });

  it('rejects a signed-in user linked to another session before cookie fallback', async () => {
    signIn('other-user');
    mocks.cookieValue = 'otherwise-valid-cookie';

    const access = await authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
      requireCardToken: false,
    });

    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.response.status).toBe(403);
    expect(mocks.verifyPaymentCookie).not.toHaveBeenCalled();
  });

  it('keeps a source-bound saved card mandatory for charge callers', async () => {
    signIn();

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
    expect(mocks.getSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      'production',
    );
    expect(mocks.orderMaybeSingle).not.toHaveBeenCalled();
  });

  it('returns a reusable card only when the account owns its exact captured main source', async () => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({ data: mainSource(), error: null });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toEqual({
      ok: true,
      vault,
      userId: 'user-1',
      resolvedVia: 'account',
    });
    expect(mocks.orderQueries[0]?.filters).toEqual(expect.arrayContaining([
      ['id', SOURCE_ORDER_DB_ID],
      ['payment_environment', 'production'],
      ['psp', 'solidgate'],
      ['session_id', SESSION_ID],
      ['product_name', MAIN_PRODUCT],
      ['product_slug', MAIN_PRODUCT],
    ]));
  });

  it('accepts an exact partial_settled capture persisted by the main finalizer', async () => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ solidgate_payment_status: 'partial_settled' }),
      error: null,
    });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toMatchObject({ ok: true, vault });
  });

  it('accepts the pending paid auth_ok reservation published by the accepted handoff', async () => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ status: 'pending', solidgate_payment_status: 'auth_ok' }),
      error: null,
    });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toMatchObject({ ok: true, vault });
  });

  it('rejects a pending order whose payment never reached auth_ok', async () => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ status: 'pending', solidgate_payment_status: null }),
      error: null,
    });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it('rejects a cookie whose main order differs from the vault source order', async () => {
    mocks.cookieValue = 'signed-main-payment';
    mocks.verifyPaymentCookie.mockResolvedValue({
      kind: 'pi',
      id: MAIN_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: MAIN_ORDER_ID,
      subscriptionId: null,
    });
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({ data: { id: 'cookie-order-row' }, error: null })
      .mockResolvedValueOnce({
        data: mainSource({
          solidgate_order_id: `${SESSION_ID}:trial3:2`,
        }),
        error: null,
      });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: null,
    }));
  });

  it('rejects a legacy subscription cookie as charge authority', async () => {
    mocks.cookieValue = 'signed-subscription';
    mocks.verifyPaymentCookie.mockResolvedValue({
      kind: 'sub',
      id: MAIN_ORDER_ID,
      sessionId: SESSION_ID,
      paymentIntentId: null,
      subscriptionId: MAIN_ORDER_ID,
    });

    const access = await authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: null,
    });

    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.response.status).toBe(403);
    expect(mocks.orderMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.getSessionVault).not.toHaveBeenCalled();
  });

  it('rejects an account when the vault source belongs to another user', async () => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ user_id: 'other-user' }),
      error: null,
    });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it('allows an arithmetically exact partial refund to keep the saved card usable', async () => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({
        amount_cents: 300,
        solidgate_payment_status: 'refunded',
        solidgate_refunded_amount_cents: 200,
      }),
      error: null,
    });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toMatchObject({ ok: true, vault });
  });

  it('rejects a full refund even when the vault still contains a token', async () => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({
        status: 'refunded',
        amount_cents: 0,
        solidgate_payment_status: 'refunded',
        solidgate_refunded_amount_cents: 500,
      }),
      error: null,
    });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it.each(['canceled', 'past_due'])('allows a %s main lifecycle after its initial capture', async (status) => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ status }),
      error: null,
    });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toMatchObject({ ok: true, vault });
  });

  it.each(['failed', 'refunded', 'disputed'])(
    'rejects the financially reversed %s order lifecycle',
    async (status) => {
      signIn();
      mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
      mocks.orderMaybeSingle.mockResolvedValue({ data: mainSource({ status }), error: null });

      await expectNoSavedCard(authorizeSolidgateSession({
        sessionId: SESSION_ID,
        sessionUserId: 'user-1',
      }));
    },
  );

  it('rejects a voided initial authorization', async () => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({ solidgate_payment_status: 'void_ok' }),
      error: null,
    });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it.each([
    ['id', { solidgate_chargeback_id: 'chargeback-1' }],
    ['status', { solidgate_chargeback_status: 'in_progress' }],
    ['amount', { solidgate_chargeback_amount_cents: 100 }],
  ])('rejects any persisted chargeback %s proof', async (_label, override) => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({ data: mainSource(override), error: null });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it('allows only the exact zero-amount main authorization', async () => {
    signIn();
    const vault = sourceBoundVault();
    mocks.getSessionVault.mockResolvedValue(vault);
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({
        amount_cents: 0,
        solidgate_original_amount_cents: 0,
        solidgate_payment_status: 'auth_ok',
        solidgate_payment_action: 'auth_0_amount',
      }),
      error: null,
    });

    await expect(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    })).resolves.toMatchObject({ ok: true, vault });

    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({
        amount_cents: 0,
        solidgate_original_amount_cents: 0,
        solidgate_payment_status: 'settle_ok',
        solidgate_payment_action: 'auth_0_amount',
      }),
      error: null,
    });
    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });

  it('rejects a legacy or incomplete checkout identity snapshot', async () => {
    signIn();
    mocks.getSessionVault.mockResolvedValue(sourceBoundVault());
    mocks.orderMaybeSingle.mockResolvedValue({
      data: mainSource({
        solidgate_checkout_identity_legacy: true,
        solidgate_checkout_identity_bound_at: null,
      }),
      error: null,
    });

    await expectNoSavedCard(authorizeSolidgateSession({
      sessionId: SESSION_ID,
      sessionUserId: 'user-1',
    }));
  });
});
