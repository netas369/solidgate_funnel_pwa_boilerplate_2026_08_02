import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  consumeResult: 'superseded' as 'consumed' | 'superseded' | (string & {}),
  specialFreeCardReadyResult: true,
  specialFreeCardReadyError: null as { message: string } | null,
  entitlementGrantResult: true,
  entitlementGrantError: null as { message: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  provisionPurchasedAccount: vi.fn(),
  enqueueMainPurchaseEnrichment: vi.fn(),
  drainSolidgateFulfillmentOutbox: vi.fn(),
  after: vi.fn(),
  afterCallbacks: [] as Array<() => void | Promise<void>>,
  linkAuthUser: vi.fn(),
  promoteSessionVaultToAccount: vi.fn(),
  status: vi.fn(),
  signAcceptedCookie: vi.fn(),
  upsertSessionVault: vi.fn(),
  getSessionVault: vi.fn(),
  entitlementRow: null as Record<string, unknown> | null,
  orderPatch: {} as Record<string, unknown>,
  orderReadPatches: [] as Array<Record<string, unknown>>,
  orderUpdates: [] as Array<Record<string, unknown>>,
  orderFilters: [] as Array<[string, unknown]>,
  updateReturnsRow: true,
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: state.after };
});

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:trial3:1`;
const ORDER_ROW = {
  id: 'db-order-1',
  session_id: SESSION_ID,
  user_id: null,
  psp: 'solidgate',
  product_name: 'BRAND_000000_SUB',
  product_slug: 'BRAND_000000_SUB',
  amount_cents: 1300,
  currency: 'eur',
  status: 'pending',
  created_at: '2026-07-16T08:50:00.000Z',
  tracking_metadata: {
    funnel_code: 'BRAND',
    funnel_variant: 'main',
    session_id: SESSION_ID,
    product_slug: 'trial3',
    price_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
    utm_source: 'fb',
  },
  solidgate_payment_status: null,
  solidgate_original_amount_cents: null,
  solidgate_refunded_amount_cents: 0,
  solidgate_chargeback_id: null,
  solidgate_chargeback_status: null,
  solidgate_chargeback_amount_cents: 0,
  solidgate_customer_email: 'buyer@example.com',
  solidgate_checkout_locale: 'lt',
  solidgate_product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
  solidgate_payment_action: 'auth_settle',
  solidgate_checkout_identity_legacy: false,
};

function settleTransaction(id: string, amount: number) {
  return {
    id,
    created_at: '2026-07-16 08:50:00',
    updated_at: '2026-07-16 08:50:01',
    amount,
    currency: 'EUR',
    operation: 'settle',
    status: 'success',
    card: {
      bin: '411111',
      brand: 'VISA',
      card_exp_month: '12',
      card_exp_year: 2028,
      number: '411111XXXXXX4242',
    },
  };
}

function tokenAuthorization(id = 'tx-auth', overrides: Record<string, unknown> = {}) {
  const overrideCardToken = overrides.card_token;
  const rest = { ...overrides };
  delete rest.card_token;
  return {
    id,
    amount: 1300,
    currency: 'EUR',
    operation: 'auth',
    status: 'success',
    card_token: {
      token: 'main-card-token',
      original_payment_method: 'card',
      ...(overrideCardToken && typeof overrideCardToken === 'object'
        ? overrideCardToken as Record<string, unknown>
        : {}),
    },
    card: {
      brand: 'VISA',
      number: '411111XXXXXX4242',
    },
    ...rest,
  };
}

function query(table: string) {
  let updatePayload: Record<string, unknown> | null = null;
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockImplementation((column: string, value: unknown) => {
    state.orderFilters.push([column, value]);
    return chain;
  });
  chain.is.mockImplementation((column: string, value: unknown) => {
    state.orderFilters.push([column, value]);
    return chain;
  });
  chain.in.mockReturnValue(chain);
  chain.update.mockImplementation((payload: Record<string, unknown>) => {
    updatePayload = payload;
    state.orderUpdates.push(payload);
    return chain;
  });
  chain.maybeSingle.mockImplementation(async () => {
    if (table === 'orders') {
      return updatePayload
        ? { data: state.updateReturnsRow ? { id: ORDER_ROW.id } : null, error: null }
        : {
            data: {
              ...ORDER_ROW,
              ...(state.orderReadPatches.shift() ?? state.orderPatch),
            },
            error: null,
          };
    }
    if (table === 'entitlements') return { data: state.entitlementRow, error: null };
    if (table === 'sessions') {
      return {
        data: {
          email: 'buyer@example.com',
          user_id: null,
          last_oto_step: null,
          updated_at: '2026-07-16T08:50:00.000Z',
          locale: 'lt',
          quiz_answers: {},
        },
        error: null,
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return chain;
}

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => query(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === 'apply_solidgate_financial_event') return Promise.resolve({ data: { net_amount_cents: 1200 }, error: null });
      if (name === 'grant_solidgate_main_entitlement') {
        return Promise.resolve({
          data: state.entitlementGrantResult,
          error: state.entitlementGrantError,
        });
      }
      if (name === 'solidgate_special_free_card_ready') {
        return Promise.resolve({
          data: state.specialFreeCardReadyResult,
          error: state.specialFreeCardReadyError,
        });
      }
      return Promise.resolve({
        data: name === 'consume_solidgate_intro_offer' ? state.consumeResult : true,
        error: null,
      });
    },
  }),
}));

vi.mock('@repo/shared/solidgate', async () => {
  const actual = await vi.importActual<typeof import('@repo/shared/solidgate')>('@repo/shared/solidgate');
  return {
    ...actual,
    SolidgateClient: class { status = state.status; },
    getSolidgateKeys: () => ({ publicKey: 'pk', secretKey: 'sk' }),
  };
});

vi.mock('@repo/shared/solidgate/session-vault', () => ({
  upsertSessionVault: state.upsertSessionVault,
  getSessionVault: state.getSessionVault,
}));
vi.mock('@repo/shared/solidgate/account-vault', () => ({ promoteSessionVaultToAccount: state.promoteSessionVaultToAccount }));
vi.mock('@repo/shared/payment-cookie', () => ({
  signPaymentCookie: vi.fn().mockResolvedValue('signed'),
  PAYMENT_COOKIE_NAME: 'payment_session',
  PAYMENT_COOKIE_MAX_AGE: 3600,
}));
vi.mock('@repo/shared/solidgate/main-accepted-cookie', () => ({
  signSolidgateMainAcceptedCookie: state.signAcceptedCookie,
  SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME: 'solidgate_main_accepted',
  SOLIDGATE_MAIN_ACCEPTED_MAX_AGE: 600,
}));
vi.mock('@/lib/payment/provision-account', () => ({
  linkAuthUser: state.linkAuthUser,
}));
vi.mock('@/lib/payment/solidgate-fulfillment', () => ({
  enqueueMainPurchaseEnrichment: state.enqueueMainPurchaseEnrichment,
  drainSolidgateFulfillmentOutbox: state.drainSolidgateFulfillmentOutbox,
}));

const { POST } = await import('../grant/route');

function request(orderId = ORDER_ID) {
  return new Request('http://localhost/api/solidgate/grant', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, sessionId: SESSION_ID }),
  });
}

function arrangeWebhookCompletedSpecialFree() {
  const orderId = `${SESSION_ID}:special_free:1`;
  state.orderPatch = {
    user_id: 'user-1',
    status: 'trialing',
    amount_cents: 0,
    solidgate_original_amount_cents: 0,
    solidgate_payment_status: 'auth_ok',
    solidgate_subscription_id: 'sub-free',
    solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
    solidgate_payment_action: 'auth_0_amount',
    tracking_metadata: {
      ...ORDER_ROW.tracking_metadata,
      funnel_variant: 'special_free',
      product_slug: 'special_free',
      price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
    },
  };
  state.entitlementRow = {
    user_id: 'user-1',
    product_slug: 'BRAND_000000_SUB',
    access_level: 'full',
    status: 'active',
    order_id: ORDER_ROW.id,
    solidgate_subscription_id: 'sub-free',
    revoked_at: null,
  };
  state.status.mockResolvedValue({
    order: {
      order_id: orderId,
      status: 'auth_ok',
      amount: 0,
      currency: 'EUR',
      refunded_amount: 0,
      subscription_id: 'sub-free',
      customer_account_id: SESSION_ID,
      product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
    },
  });
  state.getSessionVault.mockResolvedValue({
    paymentEnvironment: 'sandbox',
    sessionId: SESSION_ID,
    customerAccountId: SESSION_ID,
    sourceOrderId: ORDER_ROW.id,
    cardToken: 'webhook-card-token',
    cardOriginalPaymentMethod: 'card',
    cardBrand: 'VISA',
    cardLast4: '4242',
  });
  return orderId;
}

describe('Solidgate funnel grant introductory-offer claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rpcCalls.length = 0;
    state.consumeResult = 'superseded';
    state.specialFreeCardReadyResult = true;
    state.specialFreeCardReadyError = null;
    state.entitlementGrantResult = true;
    state.entitlementGrantError = null;
    state.entitlementRow = null;
    state.orderPatch = {};
    state.orderReadPatches.length = 0;
    state.orderUpdates.length = 0;
    state.orderFilters.length = 0;
    state.afterCallbacks.length = 0;
    state.updateReturnsRow = true;
    state.signAcceptedCookie.mockResolvedValue('accepted-signed');
    state.getSessionVault.mockResolvedValue(null);
    // Until superseded claims started granting, no test in this file ran past
    // the 409, so the provisioning mocks never needed a return shape.
    state.linkAuthUser.mockResolvedValue({
      linked: true,
      userId: 'user-1',
      isNewUser: true,
    });
    state.provisionPurchasedAccount.mockResolvedValue({ entitlementGranted: true });
    state.enqueueMainPurchaseEnrichment.mockResolvedValue(undefined);
    state.drainSolidgateFulfillmentOutbox.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 });
    state.after.mockImplementation((callback: () => void | Promise<void>) => {
      state.afterCallbacks.push(callback);
    });
    delete process.env.VERCEL_ENV;
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });
  });

  it('keeps the anonymous buyer card out of an existing email owner account vault', async () => {
    state.linkAuthUser.mockResolvedValue({ linked: false, userId: 'victim-id', isNewUser: false });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authLinked: false });
    expect(state.promoteSessionVaultToAccount).not.toHaveBeenCalled();
    expect(state.rpcCalls).toContainEqual(expect.objectContaining({
      name: 'grant_solidgate_main_entitlement', args: expect.objectContaining({ p_user_id: 'victim-id' }),
    }));
  });

  it('promotes the current purchase card after a matching verified browser login', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(state.promoteSessionVaultToAccount).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1', sessionId: SESSION_ID, paymentEnvironment: 'sandbox',
    });
  });

  /**
   * This used to answer 409 and skip provisioning, which meant a buyer Solidgate
   * had already charged walked away with no account. The ledger's job is to stop
   * us ISSUING a second payable intent, not to withhold access after the money
   * moved — so a superseded claim grants, and the refund is chased out of band.
   */
  it('still grants access when the claim was superseded — the buyer already paid', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.linkAuthUser).toHaveBeenCalled();
    expect(state.rpcCalls).toContainEqual({
      name: 'grant_solidgate_main_entitlement',
      args: expect.objectContaining({
        p_order_id: ORDER_ROW.id,
        p_user_id: 'user-1',
        p_product_slug: 'BRAND_000000_SUB',
        p_subscription_id: 'sub-1',
        p_amount_cents: 1300,
      }),
    });
    expect(state.orderUpdates).toContainEqual(expect.objectContaining({
      status: 'trialing',
      solidgate_payment_status: 'settle_ok',
      solidgate_original_amount_cents: 1300,
    }));
    expect(state.enqueueMainPurchaseEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      solidgateOrderId: ORDER_ID,
      userId: 'user-1',
      sendWelcomeEmail: true,
    }));
    expect(state.afterCallbacks).toHaveLength(1);
    await state.afterCallbacks[0]?.();
    expect(state.drainSolidgateFulfillmentOutbox).toHaveBeenCalledWith({
      paymentEnvironment: 'sandbox',
      limit: 5,
    });
    expect(
      state.rpcCalls.find((call) => call.name === 'consume_solidgate_intro_offer')?.args,
    ).toMatchObject({
      p_payment_environment: 'sandbox',
      p_session_id: SESSION_ID,
      p_tier: 'trial3',
      p_subscription_id: 'sub-1',
      p_email_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('vaults the unique exact successful main authorization token', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transactions: { 'tx-auth': tokenAuthorization() },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SESSION_ID,
        sourceOrderId: ORDER_ROW.id,
        card: {
          token: 'main-card-token',
          originalPaymentMethod: 'card',
          brand: 'VISA',
          maskedNumber: '411111XXXXXX4242',
        },
      }),
    );
  });

  it('uses signed order payment_method when Payment Form omits token provenance', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1300,
        currency: 'EUR',
        payment_method: 'card',
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transactions: {
        'tx-auth': tokenAuthorization('tx-auth', {
          card_token: {
            token: 'main-card-token',
            original_payment_method: undefined,
          },
        }),
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        card: expect.objectContaining({
          token: 'main-card-token',
          originalPaymentMethod: 'card',
        }),
      }),
    );
  });

  it.each([
    ['Apple Pay', 'apple-pay', 'apple-pay'],
    ['Google Pay', 'google-pay', 'google-pay'],
  ] as const)(
    'vaults an operation-aligned %s token with provider provenance',
    async (_label, operation, originalPaymentMethod) => {
      state.status.mockResolvedValue({
        order: {
          order_id: ORDER_ID,
          status: 'settle_ok',
          amount: 1300,
          currency: 'EUR',
          refunded_amount: 0,
          subscription_id: 'sub-1',
          customer_account_id: SESSION_ID,
          product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
        },
        transaction: tokenAuthorization('wallet-auth', {
          operation,
          card_token: {
            token: `${originalPaymentMethod}-token`,
            original_payment_method: originalPaymentMethod,
          },
        }),
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(state.upsertSessionVault).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card: expect.objectContaining({
            token: `${originalPaymentMethod}-token`,
            originalPaymentMethod,
          }),
        }),
      );
    },
  );

  it('fails before entitlement/cookie success when the source watermark cannot persist', async () => {
    state.upsertSessionVault.mockRejectedValueOnce(new Error('vault unavailable'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
  });

  it.each([
    [
      'a mapped key/id mismatch',
      { transactions: { unexpected: tokenAuthorization('tx-auth') } },
    ],
    [
      'conflicting direct and nested tokens',
      {
        transaction: tokenAuthorization('tx-auth', {
            card: {
              brand: 'VISA',
              number: '411111XXXXXX4242',
              card_token: {
                token: 'different-token',
                original_payment_method: 'card',
              },
            },
        }),
      },
    ],
    [
      'conflicting duplicate card data',
      {
        transaction: tokenAuthorization('tx-auth'),
        transactions: {
          'tx-auth': tokenAuthorization('tx-auth', {
            card: { brand: 'MASTERCARD', number: '411111XXXXXX4242' },
          }),
        },
      },
    ],
    [
      'conflicting direct and nested payment-method provenance',
      {
        transaction: tokenAuthorization('tx-auth', {
          card: {
            brand: 'VISA',
            number: '411111XXXXXX4242',
            card_token: {
              token: 'main-card-token',
              original_payment_method: 'google-pay',
            },
          },
        }),
      },
    ],
    [
      'an operation/provenance mismatch',
      {
        transaction: tokenAuthorization('tx-auth', {
          card_token: {
            token: 'main-card-token',
            original_payment_method: 'apple-pay',
          },
        }),
      },
    ],
    [
      'missing payment-method provenance',
      {
        transaction: tokenAuthorization('tx-auth', {
          card_token: {
            token: 'main-card-token',
            original_payment_method: undefined,
          },
        }),
      },
    ],
    [
      'a malformed payment-method provenance value',
      {
        transaction: tokenAuthorization('tx-auth', {
          card_token: {
            token: 'main-card-token',
            original_payment_method: ' apple-pay ',
          },
        }),
      },
    ],
    [
      'a non-authorization operation',
      { transaction: tokenAuthorization('tx-auth', { operation: 'settle' }) },
    ],
    [
      'a different amount',
      { transaction: tokenAuthorization('tx-auth', { amount: 1299 }) },
    ],
    [
      'a different currency',
      { transaction: tokenAuthorization('tx-auth', { currency: 'USD' }) },
    ],
    [
      'multiple distinct authorization tokens',
      {
        transactions: {
          'tx-auth-1': tokenAuthorization('tx-auth-1'),
          'tx-auth-2': tokenAuthorization('tx-auth-2', {
            card_token: { token: 'second-token' },
          }),
        },
      },
    ],
  ])('grants the captured main order and watermarks %s without a token', async (_case, transactionShape) => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      ...transactionShape,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SESSION_ID,
        sourceOrderId: ORDER_ROW.id,
        card: null,
      }),
    );
  });

  it('queues the per-purchase welcome even when the webhook already created the auth user', async () => {
    state.linkAuthUser.mockResolvedValue({
      linked: true,
      userId: 'user-1',
      isNewUser: false,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.enqueueMainPurchaseEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      solidgateOrderId: ORDER_ID,
      userId: 'user-1',
      sendWelcomeEmail: true,
    }));
  });

  it('fails closed on an unrecognised consume result rather than guessing', async () => {
    state.consumeResult = 'something_new';
    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'intro_offer_unverified' });
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['PSP', { psp: 'other-psp' }],
    ['main product code', { product_name: 'BRANDADDON_000000_SUB' }],
    ['canonical currency', { currency: 'EUR' }],
    ['metadata tier', {
      tracking_metadata: { ...ORDER_ROW.tracking_metadata, product_slug: 'trial2' },
    }],
  ])('rejects a persisted order with mismatched %s before provider status', async (_field, patch) => {
    state.orderPatch = patch;

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_purchase_binding' });
    expect(state.status).not.toHaveBeenCalled();
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it('grants an exact historical snapshot after live catalog price and UUIDs change', async () => {
    state.orderPatch = {
      amount_cents: 1200,
      solidgate_original_amount_cents: 1200,
      solidgate_product_id: 'historical-product-id',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        price_id: 'historical-price-id',
      },
    };
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1200,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-historical',
        customer_account_id: SESSION_ID,
        product_id: 'historical-product-id',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.status).toHaveBeenCalledWith({ order_id: ORDER_ID });
  });

  it('rejects a local amount change during provider confirmation without mutation', async () => {
    state.orderReadPatches.push({}, { amount_cents: 900 });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'local_binding_changed' });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it('rejects non-canonical attempt grammar before provider status', async () => {
    const response = await POST(request(`${SESSION_ID}:trial3:01`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_purchase_binding' });
    expect(state.status).not.toHaveBeenCalled();
    expect(state.orderUpdates).toHaveLength(0);
  });

  it.each([
    ['provider order id', { order_id: `${SESSION_ID}:trial3:2` }],
    ['original amount', { amount: 1200 }],
    ['currency', { currency: 'USD' }],
    ['customer', { customer_account_id: 'other-session' }],
    ['product', { product_id: 'wrong-product' }],
    ['subscription', { subscription_id: '' }],
  ])('rejects a mismatched %s before any mutation', async (_field, patch) => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'settle_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
        ...patch,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'payment_mismatch' });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.linkAuthUser).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it.each(['auth_failed', 'declined'])(
    'persists exact verified %s status before allowing retry',
    async (providerStatus) => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: providerStatus,
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      terminal: true,
      retryable: true,
      orderId: ORDER_ID,
      status: providerStatus,
    });
    expect(state.orderUpdates).toEqual([
      {
        status: 'failed',
        solidgate_payment_status: providerStatus,
        solidgate_original_amount_cents: 1300,
      },
    ]);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
    },
  );

  it('keeps an unknown provider status on the same pending order', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'new_provider_state',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ pending: true });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
  });

  it('blocks a documented refunded card status instead of polling or opening N+1', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'refunded',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 1300,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'grant_revoked' });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it('keeps a paid auth_ok on the same order until capture arrives', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'auth_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      status: 'auth_ok',
    });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
  });

  it('hands off an exact token-bearing paid auth_ok without granting captured access', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'auth_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transaction: tokenAuthorization(),
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      authorized: true,
      orderId: ORDER_ID,
      status: 'auth_ok',
      subscriptionId: 'sub-1',
      resumeTo: `/oto/1?sg_main=${encodeURIComponent(ORDER_ID)}`,
    });
    expect(response.headers.get('set-cookie')).toContain(
      'solidgate_main_accepted=accepted-signed',
    );
    expect(state.signAcceptedCookie).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      paymentEnvironment: 'sandbox',
    });
    expect(state.orderUpdates).toEqual([{
      solidgate_payment_status: 'auth_ok',
      solidgate_subscription_id: 'sub-1',
      solidgate_original_amount_cents: 1300,
    }]);
    // The accepted handoff publishes the reusable card and the payment cookie
    // so OTO1 can charge one-click before capture; everything that recognises
    // revenue (claim consume, account, entitlement, enrichment) still waits.
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SESSION_ID,
        sourceOrderId: ORDER_ROW.id,
        card: {
          token: 'main-card-token',
          originalPaymentMethod: 'card',
          brand: 'VISA',
          maskedNumber: '411111XXXXXX4242',
        },
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('payment_session=signed');
    expect(state.linkAuthUser).not.toHaveBeenCalled();
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.enqueueMainPurchaseEnrichment).not.toHaveBeenCalled();
    expect(state.afterCallbacks).toHaveLength(0);
  });

  it('answers pending, not revoked, when a settle webhook wins the accepted reservation CAS', async () => {
    state.updateReturnsRow = false;
    state.orderReadPatches.push({}, {
      status: 'trialing',
      solidgate_payment_status: 'settle_ok',
      solidgate_subscription_id: 'sub-1',
      solidgate_original_amount_cents: 1300,
    });
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'auth_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transaction: tokenAuthorization(),
    });

    const response = await POST(request());

    // The captured winner is THIS payment succeeding — the next poll takes the
    // ordinary success path. A 409 here showed a decline to a paid buyer.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      orderId: ORDER_ID,
      status: 'settle_ok',
    });
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers pending when the webhook\'s bare auth_ok write beats the reservation CAS', async () => {
    state.updateReturnsRow = false;
    // The auth_ok webhook writes only the payment status: no subscription id,
    // no gross — the raced row is not the identical reservation.
    state.orderReadPatches.push({}, { solidgate_payment_status: 'auth_ok' });
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'auth_ok',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transaction: tokenAuthorization(),
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      orderId: ORDER_ID,
      status: 'auth_ok',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('deduplicates singular and mapped settle transactions for exact partial capture', async () => {
    const transaction = settleTransaction('tx-settle-1', 1300);
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'partial_settled',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transaction,
      transactions: { 'tx-settle-1': transaction },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'partial_settled',
      captured: true,
      settled: true,
      fullyCaptured: true,
    });
  });

  it('sums distinct successful settle transactions for exact partial capture', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'partial_settled',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transactions: {
        'tx-settle-600': settleTransaction('tx-settle-600', 600),
        'tx-settle-700': settleTransaction('tx-settle-700', 700),
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'partial_settled',
      captured: true,
      fullyCaptured: true,
    });
  });

  it('keeps exact settlement proof when an unrelated auth has malformed provenance', async () => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'partial_settled',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      transactions: {
        'tx-settle': settleTransaction('tx-settle', 1300),
        'tx-auth': tokenAuthorization('tx-auth', {
          card_token: {
            token: 'bad-origin-token',
            original_payment_method: ' apple-pay ',
          },
        }),
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ card: null }),
    );
  });

  it.each([
    ['under-capture', {
      transaction: settleTransaction('tx-under', 1200),
    }],
    ['conflicting duplicate', {
      transaction: settleTransaction('tx-conflict', 1300),
      transactions: { 'tx-conflict': settleTransaction('tx-conflict', 650) },
    }],
  ])('keeps ambiguous partial settlement pending for %s', async (_case, transactionShape) => {
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'partial_settled',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-1',
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
      ...transactionShape,
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      status: 'partial_settled',
    });
    expect(state.orderUpdates).toHaveLength(0);
    const finance = state.rpcCalls.filter((call) => call.name === 'apply_solidgate_financial_event');
    expect(finance).toHaveLength(_case === 'under-capture' ? 1 : 0);
    if (finance.length) expect(finance[0].args.p_facts).toMatchObject({ captured_amount_cents: 1200, quoted_amount_cents: 1300 });
  });

  it.each([
    ['tokenless', {}],
    [
      'click-to-pay',
      {
        transaction: tokenAuthorization('free-click-to-pay', {
          amount: 0,
          card_token: {
            token: 'click-to-pay-token',
            original_payment_method: 'click-to-pay',
          },
        }),
      },
    ],
    [
      'operation/provenance-mismatched',
      {
        transaction: tokenAuthorization('free-wallet-mismatch', {
          amount: 0,
          operation: 'auth',
          card_token: {
            token: 'wallet-token',
            original_payment_method: 'apple-pay',
          },
        }),
      },
    ],
  ])('keeps a %s catalog-backed auth_0_amount free subscription pending without a ghost grant', async (_case, transactionShape) => {
    const freeOrderId = `${SESSION_ID}:special_free:1`;
    state.orderPatch = {
      amount_cents: 0,
      solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      solidgate_payment_action: 'auth_0_amount',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_variant: 'special_free',
        product_slug: 'special_free',
        price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    };
    state.status.mockResolvedValue({
      order: {
        order_id: freeOrderId,
        status: 'auth_ok',
        amount: 0,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-free',
        customer_account_id: SESSION_ID,
        product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
      ...transactionShape,
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      status: 'auth_ok',
      code: 'reusable_card_unverified',
    });
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.getSessionVault).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'consume_solidgate_intro_offer')).toBe(false);
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(state.linkAuthUser).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('grants special_free only after its exact reusable token persists in the session vault', async () => {
    const freeOrderId = `${SESSION_ID}:special_free:1`;
    state.orderPatch = {
      amount_cents: 0,
      solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      solidgate_payment_action: 'auth_0_amount',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_variant: 'special_free',
        product_slug: 'special_free',
        price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    };
    state.status.mockResolvedValue({
      order: {
        order_id: freeOrderId,
        status: 'auth_ok',
        amount: 0,
        currency: 'EUR',
        refunded_amount: 0,
        payment_method: 'card',
        subscription_id: 'sub-free',
        customer_account_id: SESSION_ID,
        product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
      transactions: {
        'tx-free-auth': tokenAuthorization('tx-free-auth', {
          amount: 0,
          card_token: {
            token: 'free-card-token',
            original_payment_method: undefined,
          },
        }),
      },
    });
    state.getSessionVault.mockResolvedValue({
      paymentEnvironment: 'sandbox',
      sessionId: SESSION_ID,
      customerAccountId: SESSION_ID,
      sourceOrderId: ORDER_ROW.id,
      cardToken: 'free-card-token',
    cardOriginalPaymentMethod: 'card',
      cardBrand: 'VISA',
      cardLast4: '4242',
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'auth_ok',
      captured: false,
      settled: false,
      authorizedTrial: true,
      subscriptionId: 'sub-free',
    });
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: SESSION_ID,
        sourceOrderId: ORDER_ROW.id,
        customerAccountId: SESSION_ID,
        card: expect.objectContaining({ token: 'free-card-token' }),
      }),
    );
    expect(state.getSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      'sandbox',
    );
    expect(state.rpcCalls).toContainEqual({
      name: 'solidgate_special_free_card_ready',
      args: { p_order_id: ORDER_ROW.id },
    });
    expect(state.rpcCalls.some((call) => call.name === 'consume_solidgate_intro_offer')).toBe(true);
    expect(state.linkAuthUser).toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(true);
  });

  it('accepts an exact webhook-completed special_free grant when pay/status omits transactions', async () => {
    const freeOrderId = `${SESSION_ID}:special_free:1`;
    state.orderPatch = {
      user_id: 'user-1',
      status: 'trialing',
      amount_cents: 0,
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
      solidgate_subscription_id: 'sub-free',
      solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      solidgate_payment_action: 'auth_0_amount',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_variant: 'special_free',
        product_slug: 'special_free',
        price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    };
    state.entitlementRow = {
      user_id: 'user-1',
      product_slug: 'BRAND_000000_SUB',
      access_level: 'full',
      status: 'active',
      order_id: ORDER_ROW.id,
      solidgate_subscription_id: 'sub-free',
      revoked_at: null,
    };
    state.status.mockResolvedValue({
      order: {
        order_id: freeOrderId,
        status: 'auth_ok',
        amount: 0,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-free',
        customer_account_id: SESSION_ID,
        product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    });
    state.getSessionVault.mockResolvedValue({
      paymentEnvironment: 'sandbox',
      sessionId: SESSION_ID,
      customerAccountId: SESSION_ID,
      sourceOrderId: ORDER_ROW.id,
      cardToken: 'webhook-card-token',
    cardOriginalPaymentMethod: 'card',
      cardBrand: 'VISA',
      cardLast4: '4242',
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'auth_ok',
      authorizedTrial: true,
      entitlementGranted: true,
      subscriptionId: 'sub-free',
    });
    expect(state.getSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      'sandbox',
    );
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceOrderId: ORDER_ROW.id,
        card: null,
      }),
    );
    expect(state.rpcCalls).toContainEqual({
      name: 'solidgate_special_free_card_ready',
      args: { p_order_id: ORDER_ROW.id },
    });
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('payment_session=signed');
  });

  it('recovers a card-ready special_free grant when the webhook failed before entitlement', async () => {
    const freeOrderId = `${SESSION_ID}:special_free:1`;
    state.orderPatch = {
      user_id: null,
      status: 'trialing',
      amount_cents: 0,
      solidgate_original_amount_cents: 0,
      solidgate_payment_status: 'auth_ok',
      solidgate_subscription_id: 'sub-free',
      solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      solidgate_payment_action: 'auth_0_amount',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_variant: 'special_free',
        product_slug: 'special_free',
        price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    };
    state.status.mockResolvedValue({
      order: {
        order_id: freeOrderId,
        status: 'auth_ok',
        amount: 0,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-free',
        customer_account_id: SESSION_ID,
        product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    });
    state.getSessionVault.mockResolvedValue({
      paymentEnvironment: 'sandbox',
      sessionId: SESSION_ID,
      customerAccountId: SESSION_ID,
      sourceOrderId: ORDER_ROW.id,
      cardToken: 'webhook-card-token',
    cardOriginalPaymentMethod: 'card',
      cardBrand: 'VISA',
      cardLast4: '4242',
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'auth_ok',
      authorizedTrial: true,
      entitlementGranted: true,
      subscriptionId: 'sub-free',
    });
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceOrderId: ORDER_ROW.id, card: null }),
    );
    expect(state.rpcCalls).toContainEqual({
      name: 'solidgate_special_free_card_ready',
      args: { p_order_id: ORDER_ROW.id },
    });
    expect(state.linkAuthUser).toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('payment_session=signed');
  });

  it('accepts a DB-verified newer main-card source for an already granted special_free order', async () => {
    const freeOrderId = arrangeWebhookCompletedSpecialFree();
    state.getSessionVault.mockResolvedValue({
      paymentEnvironment: 'sandbox',
      sessionId: SESSION_ID,
      customerAccountId: SESSION_ID,
      sourceOrderId: 'newer-main-order',
      cardToken: 'newer-main-card-token',
      cardOriginalPaymentMethod: 'card',
      cardBrand: 'MASTERCARD',
      cardLast4: '4444',
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      authorizedTrial: true,
      entitlementGranted: true,
    });
    expect(state.rpcCalls).toContainEqual({
      name: 'solidgate_special_free_card_ready',
      args: { p_order_id: ORDER_ROW.id },
    });
    expect(response.headers.get('set-cookie')).toContain('payment_session=signed');
  });

  it('does not recover through a conflicting durable special_free entitlement', async () => {
    const freeOrderId = arrangeWebhookCompletedSpecialFree();
    state.entitlementRow = {
      ...(state.entitlementRow ?? {}),
      solidgate_subscription_id: 'sub-other',
    };

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      code: 'reusable_card_unverified',
    });
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps webhook-completed special_free pending when the card-readiness helper says false', async () => {
    const freeOrderId = arrangeWebhookCompletedSpecialFree();
    state.specialFreeCardReadyResult = false;

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      code: 'reusable_card_unverified',
    });
    expect(state.rpcCalls).toContainEqual({
      name: 'solidgate_special_free_card_ready',
      args: { p_order_id: ORDER_ROW.id },
    });
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fails retryably without a cookie when the card-readiness helper errors', async () => {
    const freeOrderId = arrangeWebhookCompletedSpecialFree();
    state.specialFreeCardReadyError = { message: 'readiness unavailable' };

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Failed to verify special_free reusable card: readiness unavailable',
    });
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps token-backed special_free pending when the exact vault read-back is missing', async () => {
    const freeOrderId = `${SESSION_ID}:special_free:1`;
    state.orderPatch = {
      amount_cents: 0,
      solidgate_product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      solidgate_payment_action: 'auth_0_amount',
      tracking_metadata: {
        ...ORDER_ROW.tracking_metadata,
        funnel_variant: 'special_free',
        product_slug: 'special_free',
        price_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
    };
    state.status.mockResolvedValue({
      order: {
        order_id: freeOrderId,
        status: 'auth_ok',
        amount: 0,
        currency: 'EUR',
        refunded_amount: 0,
        subscription_id: 'sub-free',
        customer_account_id: SESSION_ID,
        product_id: 'dd61a0c0-5048-415e-aa77-fccef34e183f',
      },
      transactions: {
        'tx-free-auth': tokenAuthorization('tx-free-auth', {
          amount: 0,
          card_token: { token: 'free-card-token' },
        }),
      },
    });

    const response = await POST(request(freeOrderId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      status: 'auth_ok',
      code: 'reusable_card_unverified',
    });
    expect(state.upsertSessionVault).toHaveBeenCalled();
    expect(state.getSessionVault).toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'consume_solidgate_intro_offer')).toBe(false);
    expect(state.linkAuthUser).not.toHaveBeenCalled();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not vault or grant when the reversal CAS loses', async () => {
    state.updateReturnsRow = false;

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'grant_revoked' });
    expect(state.orderFilters).toContainEqual(['solidgate_refunded_amount_cents', 0]);
    expect(state.orderFilters).toContainEqual(['solidgate_chargeback_id', null]);
    expect(state.orderFilters).toContainEqual(['solidgate_chargeback_status', null]);
    expect(state.orderFilters).toContainEqual(['solidgate_chargeback_amount_cents', 0]);
    expect(state.orderFilters).toContainEqual(['solidgate_original_amount_cents', null]);
    expect(state.orderUpdates[0]).not.toHaveProperty('amount_cents');
    expect(state.orderUpdates[0]).not.toHaveProperty('currency');
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });

  it('accepts a zero-row finalizer only when an identical success webhook won', async () => {
    state.updateReturnsRow = false;
    state.orderPatch = {
      status: 'trialing',
      solidgate_payment_status: 'settle_ok',
      solidgate_subscription_id: 'sub-1',
      solidgate_original_amount_cents: 1300,
    };
    state.orderReadPatches.push({}, {});

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, settled: true });
    expect(state.upsertSessionVault).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceOrderId: ORDER_ROW.id, card: null }),
    );
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(true);
  });

  it('never downgrades an already webhook-finalized main order before repairing access', async () => {
    state.orderPatch = {
      status: 'trialing',
      solidgate_payment_status: 'settle_ok',
      solidgate_subscription_id: 'sub-1',
      solidgate_original_amount_cents: 1300,
    };

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(state.orderUpdates).toHaveLength(0);
    expect(state.rpcCalls).toContainEqual({
      name: 'grant_solidgate_main_entitlement',
      args: expect.objectContaining({
        p_order_id: ORDER_ROW.id,
        p_subscription_id: 'sub-1',
        p_amount_cents: 1300,
      }),
    });
  });

  it('does not return a success cookie while the settled buyer has no resolved auth user', async () => {
    state.linkAuthUser.mockResolvedValue({ linked: false, userId: null, isNewUser: false });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(false);
    expect(state.enqueueMainPurchaseEnrichment).not.toHaveBeenCalled();
  });

  it('fails closed when the atomic entitlement grant reports an authoritative block', async () => {
    state.entitlementGrantResult = false;

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(state.rpcCalls.some((call) => call.name === 'grant_solidgate_main_entitlement')).toBe(true);
    expect(state.enqueueMainPurchaseEnrichment).not.toHaveBeenCalled();
  });

  it('returns the exact retryable 402 when a normalized terminal webhook already won', async () => {
    state.orderPatch = {
      status: 'failed',
      amount_cents: 0,
      solidgate_original_amount_cents: 1300,
      solidgate_payment_status: 'auth_failed',
    };

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      terminal: true,
      retryable: true,
      orderId: ORDER_ID,
      status: 'auth_failed',
      code: 'payment_failed',
    });
    expect(state.status).not.toHaveBeenCalled();
    expect(state.orderUpdates).toHaveLength(0);
  });

  it('accepts only the identical normalized terminal row after a zero-row failure CAS', async () => {
    state.updateReturnsRow = false;
    state.orderReadPatches.push({}, {
      status: 'failed',
      amount_cents: 0,
      solidgate_original_amount_cents: 1300,
      solidgate_payment_status: 'auth_failed',
    });
    state.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        status: 'auth_failed',
        amount: 1300,
        currency: 'EUR',
        refunded_amount: 0,
        customer_account_id: SESSION_ID,
        product_id: '799a95f5-3628-4bcb-a644-9e7ba1b45ea7',
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      terminal: true,
      retryable: true,
      orderId: ORDER_ID,
      status: 'auth_failed',
    });
    expect(state.orderFilters).toContainEqual(['amount_cents', 1300]);
    expect(state.orderFilters).toContainEqual(['solidgate_original_amount_cents', null]);
    expect(state.upsertSessionVault).not.toHaveBeenCalled();
    expect(state.provisionPurchasedAccount).not.toHaveBeenCalled();
  });
});
