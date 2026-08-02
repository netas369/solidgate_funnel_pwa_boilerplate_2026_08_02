import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import catalogIds from '@repo/shared/solidgate/catalog-ids.json';

// The shipped catalog-ids.json is scrubbed to empty strings (see the fixture
// module); seed it so these suites reach the payment logic under test.
vi.mock('@repo/shared/solidgate/catalog-ids.json', async () => {
  const { SEEDED_CATALOG_IDS } = await import('./_seeded-catalog-ids');
  return { default: SEEDED_CATALOG_IDS };
});


const mocks = vi.hoisted(() => ({
  chargeSavedCard: vi.fn(),
  subscribeSavedCard: vi.fn(),
  insertOrder: vi.fn(),
  updateOrder: vi.fn(),
  enqueueFulfillment: vi.fn(),
  drainFulfillment: vi.fn(),
  advanceProgress: vi.fn(),
  vaultOriginalPaymentMethod: 'card' as string | null,
  after: vi.fn(),
  afterCallbacks: [] as Array<() => void | Promise<void>>,
  openOrder: vi.fn(),
  resumeOrder: vi.fn(),
  status: vi.fn(),
  upsertEntitlement: vi.fn(),
  session: {
    user_id: 'user-1',
    locale: 'lt',
    email: 'buyer@example.com',
  },
  stored: null as null | {
    amountCents: number;
    currency: string;
    metadata: Record<string, string>;
    customerEmail: string;
    checkoutLocale: string;
    solidgateProductId: string | null;
    paymentAction: string;
  },
  opened: {
    orderId: '',
    productCode: '',
    amountCents: 0,
    currency: 'eur',
    builderToken: '',
    metadata: {} as Record<string, string>,
    customerEmail: 'buyer@example.com',
    checkoutLocale: 'lt',
    solidgateProductId: null as string | null,
    paymentAction: 'auth_settle',
    providerStatus: null as string | null,
    verifyUrl: null as string | null,
  },
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: mocks.after };
});

vi.mock('@repo/shared/solidgate', async () => {
  const actual = await vi.importActual<typeof import('@repo/shared/solidgate')>('@repo/shared/solidgate');
  return {
    ...actual,
    SolidgateClient: class { status = mocks.status; },
    getSolidgateKeys: () => ({ publicKey: 'pk', secretKey: 'sk' }),
    chargeSavedCard: mocks.chargeSavedCard,
    subscribeSavedCard: mocks.subscribeSavedCard,
  };
});

vi.mock('@/lib/payment/solidgate-access', () => ({
  authorizeSolidgateSession: vi.fn(async () => ({
    ok: true,
    userId: 'user-1',
    vault: {
      cardToken: 'card-token',
      cardOriginalPaymentMethod: mocks.vaultOriginalPaymentMethod,
      customerAccountId: 'customer-1',
    },
  })),
}));

vi.mock('@/lib/payment/solidgate-fulfillment', () => ({
  drainSolidgateFulfillmentOutbox: mocks.drainFulfillment,
  enqueueCapturedOtoFulfillment: mocks.enqueueFulfillment,
}));

vi.mock('@repo/shared/entitlements', () => ({
  upsertEntitlement: mocks.upsertEntitlement,
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'advance_solidgate_oto_progress') {
        return mocks.advanceProgress(args);
      }
      if (name === 'resume_solidgate_oto_order_after_absent_reconcile') {
        return mocks.resumeOrder(args);
      }
      if (name === 'grant_solidgate_oto_entitlement') {
        return mocks.upsertEntitlement(args);
      }
      if (name !== 'open_solidgate_oto_order_v2') throw new Error(`unexpected rpc ${name}`);
      const productId = String(args.p_order_prefix).split(':').at(-1)!;
      mocks.opened.orderId = `${SESSION_ID}:${productId}:1`;
      mocks.opened.productCode = String(args.p_product_slug);
      mocks.opened.amountCents = Number(args.p_amount_cents);
      mocks.opened.currency = String(args.p_currency);
      mocks.opened.builderToken = String(args.p_builder_token);
      mocks.opened.metadata = args.p_tracking_metadata as Record<string, string>;
      mocks.opened.customerEmail = String(args.p_customer_email);
      mocks.opened.checkoutLocale = String(args.p_checkout_locale);
      mocks.opened.solidgateProductId = typeof args.p_solidgate_product_id === 'string'
        ? args.p_solidgate_product_id
        : null;
      mocks.opened.paymentAction = String(args.p_solidgate_payment_action);
      const result = await mocks.openOrder(args, mocks.opened.orderId) as {
        data: Array<Record<string, unknown>> | null;
        error: unknown;
      };
      return {
        ...result,
        data: result.data?.map((row) => ({
          ...row,
          bound_original_amount_cents:
            row.bound_original_amount_cents ?? mocks.opened.amountCents,
          bound_currency: row.bound_currency ?? mocks.opened.currency,
          bound_tracking_metadata: row.bound_tracking_metadata ?? mocks.opened.metadata,
          bound_customer_email: row.bound_customer_email ?? mocks.opened.customerEmail,
          bound_checkout_locale: row.bound_checkout_locale ?? mocks.opened.checkoutLocale,
          bound_solidgate_product_id: Object.prototype.hasOwnProperty.call(
            row,
            'bound_solidgate_product_id',
          )
            ? row.bound_solidgate_product_id
            : mocks.opened.solidgateProductId,
          bound_solidgate_payment_action:
            row.bound_solidgate_payment_action ?? mocks.opened.paymentAction,
        })) ?? null,
      };
    },
    from: (table: string) => {
      if (table === 'sessions') {
        const updateChain: Record<string, unknown> = {};
        updateChain.eq = () => updateChain;
        updateChain.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: mocks.session,
                error: null,
              }),
            }),
          }),
          update: () => updateChain,
        };
      }
      if (table === 'orders') {
        return {
          select: () => {
            const binding = mocks.stored ?? mocks.opened;
            const confirmOrder = {
              id: 'order-db-id',
              user_id: 'user-1',
              psp: 'solidgate',
              product_name: mocks.opened.productCode,
              solidgate_order_id: mocks.opened.orderId,
              session_id: SESSION_ID,
              product_slug: mocks.opened.productCode,
              status: 'pending',
              amount_cents: binding.amountCents,
              currency: binding.currency,
              solidgate_original_amount_cents: binding.amountCents,
              solidgate_product_id: binding.solidgateProductId,
              solidgate_payment_action: binding.paymentAction,
              tracking_metadata: binding.metadata,
              solidgate_customer_email: binding.customerEmail,
              solidgate_checkout_locale: binding.checkoutLocale,
              solidgate_checkout_identity_bound_at: '2026-07-21T09:59:00.000Z',
              solidgate_checkout_identity_legacy: false,
              solidgate_payment_status: mocks.opened.providerStatus,
              solidgate_verify_url: mocks.opened.verifyUrl,
              solidgate_refunded_amount_cents: 0,
              solidgate_chargeback_id: null,
              solidgate_chargeback_status: null,
              solidgate_chargeback_amount_cents: 0,
              solidgate_submission_token: mocks.opened.builderToken,
              solidgate_submission_started_at: '2026-07-21T10:00:00.000Z',
            };
            const makeChain = (): Record<string, unknown> => ({
              eq: () => makeChain(),
              maybeSingle: async () => ({
                data: confirmOrder,
                error: null,
              }),
            });
            return makeChain();
          },
          update: (row: Record<string, unknown>) => {
            mocks.updateOrder(row);
            const chain: Record<string, unknown> = {};
            chain.eq = () => chain;
            chain.is = () => chain;
            chain.in = () => chain;
            chain.select = () => chain;
            chain.maybeSingle = async () => ({ data: { id: 'order-db-id' }, error: null });
            chain.then = (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(resolve);
            return chain;
          },
        };
      }
      if (table === 'entitlements') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST } = await import('../charge-oto/route');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function otoRequest(slug = 'oto3_bundle_all') {
  return new Request('http://localhost/api/solidgate/charge-oto', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '185.179.185.6',
    },
    body: JSON.stringify({
      sessionId: SESSION_ID,
      slug,
      returnUrl: 'http://localhost/lt/oto/3',
    }),
  });
}

describe('Solidgate OTO attribution metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.afterCallbacks.length = 0;
    mocks.after.mockImplementation((callback: () => void | Promise<void>) => {
      mocks.afterCallbacks.push(callback);
    });
    mocks.drainFulfillment.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 });
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_FUNNEL_URL;
    mocks.opened.providerStatus = null;
    mocks.opened.verifyUrl = null;
    mocks.stored = null;
    mocks.session.user_id = 'user-1';
    mocks.session.locale = 'lt';
    mocks.session.email = 'buyer@example.com';
    mocks.vaultOriginalPaymentMethod = 'card';
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'success',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      subscriptionId: null,
      amount: 4_900,
      orderAmount: 4_900,
      currency: 'eur',
      providerStatus: 'settle_ok',
    });
    // The subscription OTO settles its intro amount (auth_settle);
    // the route rejects the old zero-amount success shape as a binding
    // mismatch.
    mocks.subscribeSavedCard.mockResolvedValue({
      status: 'success',
      orderId: `${SESSION_ID}:oto2_addon_weekly:1`,
      providerOrderId: `${SESSION_ID}:oto2_addon_weekly:1`,
      customerAccountId: 'customer-1',
      subscriptionId: 'subscription-uuid',
      amount: 100,
      orderAmount: 100,
      settledAmount: 100,
      currency: 'eur',
      // Must match the live catalog binding — the route rejects a provider
      // product that differs from catalog-ids' addon_trial entry, and the
      // entry changes every time the product is archived + re-seeded.
      productId: (catalogIds as Record<string, { product_id: string }>).addon_trial.product_id,
      providerStatus: 'settle_ok',
    });
    mocks.openOrder.mockImplementation(async (_args, orderId) => ({
      data: [{
        order_db_id: 'order-db-id',
        solidgate_order_id: orderId,
        order_status: 'pending',
        solidgate_payment_status: 'creating',
        is_new: true,
        should_submit: true,
        needs_reconcile: false,
        claim_token: _args.p_builder_token,
      }],
      error: null,
    }));
    mocks.resumeOrder.mockResolvedValue({ data: true, error: null });
    mocks.status.mockResolvedValue({});
    mocks.upsertEntitlement.mockResolvedValue({ data: true, error: null });
    mocks.advanceProgress.mockImplementation(async (args: Record<string, unknown>) => ({
      data: [{
        persisted_step: Number(args.p_current_step) + 1,
        advanced: true,
        conflict: false,
      }],
      error: null,
    }));
  });

  it('reserves the tenth metadata slot for a subscription price ID', async () => {
    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '185.179.185.6',
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto2_addon_weekly',
          returnUrl: 'http://localhost/lt/oto/2',
          attribution: {
            first_touch: {
              utm_source: 'fb',
              utm_medium: 'Facebook_Mobile_Feed',
              utm_campaign: 'Campaign A',
              utm_content: 'Creative 7',
              utm_term: 'Broad',
            },
            last_touch: { utm_source: 'fb' },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const subscribeParams = mocks.subscribeSavedCard.mock.calls[0]?.[1] as {
      metadata: Record<string, string>;
      paymentType: string;
    };
    expect(subscribeParams.paymentType).toBe('1-click');
    expect(subscribeParams.metadata).toEqual({
      funnel_code: 'BRAND',
      funnel_variant: 'oto2',
      session_id: SESSION_ID,
      product_slug: 'oto2_addon_weekly',
      price_id: expect.any(String),
      utm_source: 'fb',
      utm_medium: 'Facebook_Mobile_Feed',
      utm_campaign: 'Campaign A',
      utm_content: 'Creative 7',
      utm_term: 'Broad',
    });
    expect(Object.keys(subscribeParams.metadata)).toHaveLength(10);
    expect(await response.json()).toMatchObject({
      tracking: {
        billing_type: 'subscription_initial',
        price_id: expect.any(String),
      },
    });
    expect(mocks.advanceProgress).toHaveBeenCalledWith({
      p_payment_environment: 'sandbox',
      p_session_id: SESSION_ID,
      p_current_step: 2,
      p_allow_catch_up: true,
    });
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(mocks.drainFulfillment).not.toHaveBeenCalled();
    await mocks.afterCallbacks[0]?.();
    expect(mocks.drainFulfillment).toHaveBeenCalledWith({
      paymentEnvironment: 'sandbox',
      limit: 5,
    });
  });

  afterEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_FUNNEL_URL;
  });

  it('sends the exact 10-key canonical metadata contract and returns canonical tracking', async () => {
    // A different tab has already advanced this session. The response must
    // follow the winning durable checkpoint, not OTO3's hardcoded successor.
    mocks.advanceProgress.mockResolvedValueOnce({
      data: [{ persisted_step: 6, advanced: false, conflict: false }],
      error: null,
    });
    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '185.179.185.6',
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          returnUrl: 'http://localhost/lt/oto/3?utm_source=fb#checkout',
          attribution: {
            first_touch: {
              utm_source: 'fb',
              utm_medium: 'Facebook_Mobile_Feed',
              utm_campaign: 'Campaign A',
              utm_content: 'Creative 7',
              utm_term: 'Broad',
              gclid: 'not-sent-because-of-cap',
            },
            last_touch: { utm_source: 'google' },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    const chargeParams = mocks.chargeSavedCard.mock.calls[0]?.[1] as {
      metadata: Record<string, string>;
      successUrl: string;
      paymentType: string;
    };
    expect(chargeParams.paymentType).toBe('1-click');
    // Solidgate rejects non-https success_url with 2.01 "not a valid URL",
    // killing the whole charge — on an http origin (local dev) the route now
    // omits the field entirely instead of failing every OTO payment.
    expect(chargeParams.successUrl).toBeUndefined();
    expect(chargeParams.metadata).toEqual({
      funnel_code: 'BRAND',
      funnel_variant: 'oto3',
      session_id: SESSION_ID,
      product_slug: 'oto3_bundle_all',
      locale: 'lt',
      utm_source: 'fb',
      utm_medium: 'Facebook_Mobile_Feed',
      utm_campaign: 'Campaign A',
      utm_content: 'Creative 7',
      utm_term: 'Broad',
    });
    expect(Object.keys(chargeParams.metadata)).toHaveLength(10);
    expect(chargeParams.metadata).not.toHaveProperty('gclid');

    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      amountCents: 4_900,
      currency: 'eur',
      productSlug: 'oto3_bundle_all',
      lastOtoStep: '6',
      resumeTo: '/oto/6',
      nextOto: '/oto/6',
      tracking: {
        payment_provider: 'solidgate',
        billing_type: 'one_time',
        funnel_code: 'BRAND',
        funnel_variant: 'oto3',
        product_id: 'BRANDBUNDLE_000000_PDF',
        product_code: 'BRANDBUNDLE_000000_PDF',
        product_name: 'Bundle (all)',
        product_slug: 'oto3_bundle_all',
        price_id: null,
        solidgate_product_id: null,
        amount_cents: 4_900,
        currency: 'EUR',
      },
    });
  });

  it.each(['apple-pay', 'google-pay'])(
    'submits a %s token as rebill',
    async (originalPaymentMethod) => {
      mocks.vaultOriginalPaymentMethod = originalPaymentMethod;

      const response = await POST(otoRequest());

      expect(response.status).toBe(200);
      expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ paymentType: 'rebill' }),
      );
    },
  );

  it.each([null, 'click-to-pay', 'unknown'])(
    'fails closed before opening an order for unsupported token origin %s',
    async (originalPaymentMethod) => {
      mocks.vaultOriginalPaymentMethod = originalPaymentMethod;

      const response = await POST(otoRequest());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'payment_method_unverified',
      });
      expect(mocks.openOrder).not.toHaveBeenCalled();
      expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    },
  );

  it('lets only the atomic order creator call /recurring under a double click', async () => {
    let opened = 0;
    mocks.openOrder.mockImplementation(async (args, orderId) => {
      opened += 1;
      return {
        data: [{
          order_db_id: 'order-db-id',
          solidgate_order_id: orderId,
          order_status: 'pending',
          solidgate_payment_status: 'creating',
          is_new: opened === 1,
          should_submit: opened === 1,
          needs_reconcile: false,
          claim_token: opened === 1 ? args.p_builder_token : null,
        }],
        error: null,
      };
    });
    const request = () => new Request('http://localhost/api/solidgate/charge-oto', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '185.179.185.6',
      },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        slug: 'oto3_bundle_all',
        returnUrl: 'http://localhost/lt/oto/3',
      }),
    });

    const responses = await Promise.all([POST(request()), POST(request())]);

    expect(mocks.openOrder).toHaveBeenCalledTimes(2);
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
  });

  it('keeps a timed-out /recurring submission on the same leased order', async () => {
    mocks.chargeSavedCard.mockRejectedValue(
      new DOMException('Solidgate request timed out', 'TimeoutError'),
    );

    const response = await POST(otoRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.updateOrder).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('accepts processing with settled_amount zero without granting or emitting Purchase data', async () => {
    mocks.advanceProgress.mockResolvedValueOnce({
      data: [{ persisted_step: 7, advanced: false, conflict: false }],
      error: null,
    });
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: 0,
      currency: 'eur',
      providerStatus: 'processing',
    });

    const response = await POST(otoRequest());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      productSlug: 'oto3_bundle_all',
      lastOtoStep: '7',
      resumeTo: '/oto/7',
      nextOto: '/oto/7',
      providerStatus: 'processing',
      orderAmountCents: 4_900,
      settledAmountCents: 0,
    });
    expect(body).not.toHaveProperty('tracking');
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      solidgate_payment_status: 'processing',
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    }));
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('does not advance on created before Solidgate has accepted a payment attempt', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: 0,
      currency: 'eur',
      providerStatus: 'created',
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      providerStatus: 'created',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
    });
    expect(body).not.toHaveProperty('nextOto');
    expect(mocks.advanceProgress).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('rejects an immediate provider response bound to a different order identity', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'success',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:999`,
      customerAccountId: 'customer-1',
      subscriptionId: null,
      amount: 4_900,
      orderAmount: 4_900,
      settledAmount: 4_900,
      currency: 'eur',
      providerStatus: 'settle_ok',
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'binding_mismatch' });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('retires explicit auth_failed evidence so a later attempt may safely use N+1', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'failed',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      orderAmount: 4_900,
      settledAmount: null,
      currency: 'eur',
      providerStatus: 'auth_failed',
      errorCode: '3.02',
      errorMessage: 'Payment declined',
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(402);
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      amount_cents: 0,
      solidgate_payment_status: 'auth_failed',
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    }));
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('retires a definite request rejection so the atomic opener may use N+1', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'failed',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      orderAmount: 4_900,
      settledAmount: null,
      currency: 'eur',
      providerStatus: 'request_rejected',
      errorCode: '2.01',
      errorMessage: 'Request is invalid',
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(402);
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      amount_cents: 0,
      solidgate_payment_status: 'request_rejected',
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    }));
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('does not retire a rejected request carrying conflicting challenge aliases', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'failed',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerStatus: 'request_rejected',
      verifyUrlConflict: true,
      errorCode: '2.01',
      errorMessage: 'Request is contradictory',
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(502);
    expect(mocks.updateOrder).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('never accepts 3ds_verify without a stored challenge URL', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: 0,
      currency: 'eur',
      providerStatus: '3ds_verify',
    });

    const response = await POST(otoRequest());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      providerStatus: '3ds_verify',
      orderAmountCents: 4_900,
      settledAmountCents: 0,
    });
    expect(body).not.toHaveProperty('nextOto');
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('does not reuse a stored ACS URL after an immediate alias conflict', async () => {
    mocks.opened.verifyUrl = 'https://acs.example/verify/stored-challenge';
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: 0,
      currency: 'eur',
      providerStatus: '3ds_verify',
      verifyUrlConflict: true,
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      providerStatus: '3ds_verify',
    });
    expect(body).not.toHaveProperty('verifyUrl');
    expect(body).not.toHaveProperty('nextOto');
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      solidgate_payment_status: '3ds_verify',
      solidgate_verify_url: null,
    }));
  });

  it('keeps an under-captured partial settlement on one provider order across retry', async () => {
    let opened = 0;
    mocks.openOrder.mockImplementation(async (args, orderId) => {
      opened += 1;
      return {
        data: [{
          order_db_id: 'order-db-id',
          solidgate_order_id: orderId,
          order_status: 'pending',
          solidgate_payment_status: opened === 1 ? 'creating' : 'partial_settled',
          is_new: opened === 1,
          should_submit: opened === 1,
          needs_reconcile: false,
          claim_token: opened === 1 ? args.p_builder_token : null,
        }],
        error: null,
      };
    });
    const partial = {
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 2_999,
      orderAmount: 4_900,
      settledAmount: 2_999,
      currency: 'eur',
      providerStatus: 'partial_settled',
    };
    mocks.chargeSavedCard.mockResolvedValue(partial);
    mocks.status.mockResolvedValue({
      order: {
        order_id: `${SESSION_ID}:oto3_bundle_all:1`,
        customer_account_id: 'customer-1',
        status: 'partial_settled',
        amount: 4_900,
        currency: 'eur',
      },
      transactions: {
        'settle-1': {
          id: 'settle-1',
          operation: 'settle',
          status: 'success',
          amount: 2_999,
          currency: 'EUR',
        },
      },
    });

    const first = await POST(otoRequest());
    mocks.opened.providerStatus = 'partial_settled';
    const second = await POST(otoRequest());

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({
      accepted: false,
      providerStatus: 'partial_settled',
      settledAmountCents: 2_999,
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
    });
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.resumeOrder).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it('never promotes a missing provider status to accepted processing on retry', async () => {
    let opened = 0;
    mocks.openOrder.mockImplementation(async (args, orderId) => {
      opened += 1;
      return {
        data: [{
          order_db_id: 'order-db-id',
          solidgate_order_id: orderId,
          order_status: 'pending',
          solidgate_payment_status: opened === 1 ? 'creating' : 'status_unknown',
          is_new: opened === 1,
          should_submit: opened === 1,
          needs_reconcile: false,
          claim_token: opened === 1 ? args.p_builder_token : null,
        }],
        error: null,
      };
    });
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'pending',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: null,
      currency: 'eur',
      providerStatus: undefined,
    });
    mocks.status.mockResolvedValue({
      order: {
        order_id: `${SESSION_ID}:oto3_bundle_all:1`,
        customer_account_id: 'customer-1',
        amount: 4_900,
        currency: 'eur',
      },
    });

    const first = await POST(otoRequest());
    mocks.opened.providerStatus = 'status_unknown';
    const second = await POST(otoRequest());

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({ accepted: false, pending: true });
    await expect(second.json()).resolves.toMatchObject({ accepted: false, pending: true });
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      solidgate_payment_status: 'status_unknown',
    }));
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.advanceProgress).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it('takes over an expired creating lease only after one absent status reconciliation', async () => {
    mocks.openOrder.mockImplementation(async (args, orderId) => ({
      data: [{
        order_db_id: 'order-db-id',
        solidgate_order_id: orderId,
        order_status: 'pending',
        solidgate_payment_status: 'creating',
        is_new: false,
        should_submit: false,
        needs_reconcile: true,
        claim_token: args.p_builder_token,
      }],
      error: null,
    }));
    mocks.status.mockResolvedValue({
      error: {
        code: '2.01',
        messages: { order: ['Order not found.'] },
      },
    });

    const response = await POST(otoRequest());
    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.resumeOrder).toHaveBeenCalledWith(expect.objectContaining({
      p_order_db_id: 'order-db-id',
      p_solidgate_order_id: `${SESSION_ID}:oto3_bundle_all:1`,
    }));
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.chargeSavedCard.mock.calls[0]?.[1]).toMatchObject({
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
    });
  });

  it('recovers an exact leased order from its immutable snapshot after session and catalog drift', async () => {
    const historicMetadata = {
      funnel_code: 'BRAND',
      funnel_variant: 'oto3',
      session_id: SESSION_ID,
      product_slug: 'oto3_bundle_all',
      locale: 'en',
      utm_source: 'historic-source',
    };
    mocks.stored = {
      amountCents: 4_200,
      currency: 'usd',
      metadata: historicMetadata,
      customerEmail: 'historic-buyer@example.com',
      checkoutLocale: 'en',
      solidgateProductId: null,
      paymentAction: 'auth_settle',
    };
    mocks.openOrder.mockImplementation(async (args, orderId) => ({
      data: [{
        order_db_id: 'order-db-id',
        solidgate_order_id: orderId,
        order_status: 'pending',
        solidgate_payment_status: 'creating',
        is_new: false,
        should_submit: false,
        needs_reconcile: true,
        claim_token: args.p_builder_token,
        bound_original_amount_cents: 4_200,
        bound_currency: 'usd',
        bound_tracking_metadata: historicMetadata,
        bound_customer_email: 'historic-buyer@example.com',
        bound_checkout_locale: 'en',
        bound_solidgate_product_id: null,
        bound_solidgate_payment_action: 'auth_settle',
      }],
      error: null,
    }));
    mocks.status.mockResolvedValue({
      error: {
        code: '2.01',
        messages: { order: ['Order not found.'] },
      },
    });
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'success',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      subscriptionId: null,
      amount: 4_200,
      orderAmount: 4_200,
      settledAmount: 4_200,
      currency: 'usd',
      providerStatus: 'settle_ok',
    });

    const response = await POST(new Request('http://localhost/api/solidgate/charge-oto', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '185.179.185.6',
      },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        slug: 'oto3_bundle_all',
        returnUrl: 'http://localhost/lt/oto/3',
        attribution: {
          first_touch: { utm_source: 'fresh-source' },
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.openOrder).toHaveBeenCalledWith(expect.objectContaining({
      p_customer_email: 'buyer@example.com',
      p_checkout_locale: 'lt',
      p_solidgate_product_id: null,
      p_solidgate_payment_action: 'auth_settle',
      p_tracking_metadata: expect.objectContaining({
        locale: 'lt',
        utm_source: 'fresh-source',
      }),
    }), `${SESSION_ID}:oto3_bundle_all:1`);
    expect(mocks.chargeSavedCard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      amount: 4_200,
      currency: 'usd',
      customerEmail: 'historic-buyer@example.com',
      metadata: historicMetadata,
    }));
  });

  it('does not resubmit an expired lease from an ambiguous no-order status response', async () => {
    mocks.openOrder.mockImplementation(async (args, orderId) => ({
      data: [{
        order_db_id: 'order-db-id',
        solidgate_order_id: orderId,
        order_status: 'pending',
        solidgate_payment_status: 'creating',
        is_new: false,
        should_submit: false,
        needs_reconcile: true,
        claim_token: args.p_builder_token,
      }],
      error: null,
    }));
    mocks.status.mockResolvedValue({
      error: {
        code: '2.01',
        messages: { amount: ['This value is not valid.'] },
      },
    });

    const response = await POST(otoRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      accepted: false,
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
    });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.resumeOrder).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it('refuses partial capture when transaction evidence is not the exact bound amount', async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      status: 'success',
      orderId: `${SESSION_ID}:oto3_bundle_all:1`,
      providerOrderId: `${SESSION_ID}:oto3_bundle_all:1`,
      customerAccountId: 'customer-1',
      amount: 0,
      orderAmount: 4_900,
      settledAmount: 0,
      currency: 'eur',
      providerStatus: 'partial_settled',
    });

    const response = await POST(otoRequest());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'binding_mismatch' });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('rejects an external 3DS return URL before binding or charging an order', async () => {
    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          returnUrl: 'https://evil.example/lt/oto/3',
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.insertOrder).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it('uses only the configured funnel origin for a Production 3DS return', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_FUNNEL_URL = 'https://funnel.example.com';
    const response = await POST(
      new Request('https://deployment-id.vercel.app/api/solidgate/charge-oto', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '185.179.185.6',
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          returnUrl: 'https://funnel.example.com/lt/oto/3',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const chargeParams = mocks.chargeSavedCard.mock.calls[0]?.[1] as { successUrl: string };
    expect(chargeParams.successUrl).toBe(
      `https://funnel.example.com/lt/oto/3?sg_confirm=${encodeURIComponent(`${SESSION_ID}:oto3_bundle_all:1`)}`,
    );
  });
});
