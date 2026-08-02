import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  orderMaybeSingle: vi.fn(),
  entitlementMaybeSingle: vi.fn(),
  upsertEntitlement: vi.fn(),
  enqueueFulfillment: vi.fn(),
  drainFulfillment: vi.fn(),
  advanceProgress: vi.fn(),
  after: vi.fn(),
  afterCallbacks: [] as Array<() => void | Promise<void>>,
}));

function query<T>(result: T) {
  const chain = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  chain.select.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  return chain;
}

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      if (name === 'advance_solidgate_oto_progress') {
        return mocks.advanceProgress(args);
      }
      if (name === 'grant_solidgate_oto_entitlement') {
        return mocks.upsertEntitlement(args);
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      if (table === 'sessions') {
        return query({ data: { user_id: 'user-1', locale: 'lt', email: 'buyer@example.com' }, error: null });
      }
      if (table === 'orders') {
        const chain = query({ data: null, error: null });
        chain.maybeSingle = mocks.orderMaybeSingle;
        return chain;
      }
      if (table === 'entitlements') {
        const chain = query({ data: null, error: null });
        chain.maybeSingle = mocks.entitlementMaybeSingle;
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
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
  };
});

vi.mock('@/lib/payment/solidgate-access', () => ({
  authorizeSolidgateSession: vi.fn(async () => ({
    ok: true,
    userId: 'user-1',
    vault: {
      cardToken: 'card-token',
      cardOriginalPaymentMethod: 'card',
      customerAccountId: 'customer-1',
    },
  })),
}));

vi.mock('@/lib/payment/solidgate-fulfillment', () => ({
  drainSolidgateFulfillmentOutbox: mocks.drainFulfillment,
  enqueueCapturedOtoFulfillment: mocks.enqueueFulfillment,
}));
vi.mock('@repo/shared/entitlements', () => ({ upsertEntitlement: mocks.upsertEntitlement }));

const { POST } = await import('../charge-oto/route');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:oto3_bundle_all:1`;

function boundOtoOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db-order-1',
    user_id: 'user-1',
    psp: 'solidgate',
    product_name: 'BRANDBUNDLE_000000_PDF',
    solidgate_order_id: ORDER_ID,
    session_id: SESSION_ID,
    product_slug: 'BRANDBUNDLE_000000_PDF',
    status: 'pending',
    amount_cents: 3000,
    currency: 'eur',
    solidgate_original_amount_cents: 3000,
    solidgate_product_id: null,
    solidgate_payment_action: 'auth_settle',
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'oto3',
      session_id: SESSION_ID,
      product_slug: 'oto3_bundle_all',
      locale: 'lt',
    },
    solidgate_customer_email: 'buyer@example.com',
    solidgate_checkout_locale: 'lt',
    solidgate_checkout_identity_bound_at: '2026-07-21T09:59:00.000Z',
    solidgate_checkout_identity_legacy: false,
    solidgate_subscription_id: null,
    solidgate_payment_status: '3ds_verify',
    solidgate_verify_url: null,
    solidgate_refunded_amount_cents: 0,
    solidgate_chargeback_id: null,
    solidgate_chargeback_status: null,
    solidgate_chargeback_amount_cents: 0,
    solidgate_submission_token: null,
    solidgate_submission_started_at: null,
    ...overrides,
  };
}

function arrangeCapturedLifetime() {
  const lifetimeOrderId = `${SESSION_ID}:oto1_lifetime:1`;
  const lifetimeOrder = boundOtoOrder({
    product_name: 'BRANDLIFETIME_000000_SUB',
    solidgate_order_id: lifetimeOrderId,
    product_slug: 'BRANDLIFETIME_000000_SUB',
    amount_cents: 9900,
    solidgate_original_amount_cents: 9900,
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'oto1',
      session_id: SESSION_ID,
      product_slug: 'oto1_lifetime',
      locale: 'lt',
    },
    solidgate_payment_status: 'creating',
  });
  mocks.orderMaybeSingle.mockResolvedValue({ data: lifetimeOrder, error: null });
  mocks.status.mockResolvedValue({
    order: {
      order_id: lifetimeOrderId,
      customer_account_id: 'customer-1',
      status: 'settle_ok',
      amount: 9900,
      currency: 'eur',
    },
  });
  return lifetimeOrderId;
}

function confirmRequest(slug: string, orderId: string) {
  return new Request('http://localhost/api/solidgate/charge-oto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, slug, confirmOrderId: orderId }),
  });
}

describe('Solidgate OTO confirmation replay guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.afterCallbacks.length = 0;
    delete process.env.VERCEL_ENV;
    mocks.entitlementMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.upsertEntitlement.mockResolvedValue({ data: true, error: null });
    mocks.enqueueFulfillment.mockResolvedValue(undefined);
    mocks.drainFulfillment.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 });
    mocks.after.mockImplementation((callback: () => void | Promise<void>) => {
      mocks.afterCallbacks.push(callback);
    });
    mocks.advanceProgress.mockImplementation(async (args: Record<string, unknown>) => ({
      data: [{
        persisted_step: Number(args.p_current_step) + 1,
        advanced: true,
        conflict: false,
      }],
      error: null,
    }));
  });

  it('does not re-grant a refunded OTO from its old 3DS confirmation URL', async () => {
    mocks.orderMaybeSingle.mockResolvedValue({
      data: {
        id: 'db-order-1',
        session_id: SESSION_ID,
        product_slug: 'BRANDBUNDLE_000000_PDF',
        status: 'refunded',
        solidgate_payment_status: 'refunded',
        solidgate_refunded_amount_cents: 3000,
        solidgate_chargeback_id: null,
        solidgate_chargeback_status: null,
        solidgate_chargeback_amount_cents: 0,
      },
      error: null,
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'grant_revoked' });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it('fails closed before reading the provider when the bound row is not an OTO', async () => {
    mocks.orderMaybeSingle.mockResolvedValue({
      data: {
        id: 'db-order-1',
        solidgate_order_id: ORDER_ID,
        session_id: SESSION_ID,
        product_slug: 'BRAND_000000_SUB',
        status: 'pending',
        amount_cents: 3000,
        currency: 'eur',
        solidgate_payment_status: 'auth_ok',
        solidgate_verify_url: null,
        solidgate_refunded_amount_cents: 0,
        solidgate_chargeback_id: null,
        solidgate_chargeback_status: null,
        solidgate_chargeback_amount_cents: 0,
      },
      error: null,
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'binding_mismatch' });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('replays the stored 3DS challenge instead of accepting or advancing', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({
        data: boundOtoOrder({
          solidgate_payment_status: '3ds_verify',
          solidgate_verify_url: 'https://acs.example/verify/order-1',
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: '3ds_verify',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      requiresAction: true,
      verifyUrl: 'https://acs.example/verify/order-1',
      orderId: ORDER_ID,
    });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('clears a stale stored 3DS URL and advances when the provider says processing', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({
        data: boundOtoOrder({
          solidgate_payment_status: 'processing',
          solidgate_verify_url: 'https://acs.example/verify/processing-order-1',
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: 'processing',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      orderId: ORDER_ID,
      providerStatus: 'processing',
      nextOto: '/oto/4',
    });
    expect(mocks.advanceProgress).toHaveBeenCalledTimes(1);
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('never reopens a stale ACS URL after the provider reaches auth_ok', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({
        data: boundOtoOrder({
          solidgate_payment_status: '3ds_verify',
          solidgate_verify_url: 'https://acs.example/verify/old-challenge',
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: 'auth_ok',
        amount: 3000,
        currency: 'eur',
      },
      verify_url: 'https://acs.example/verify/old-challenge',
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      providerStatus: 'auth_ok',
      nextOto: '/oto/4',
    });
    expect(mocks.advanceProgress).toHaveBeenCalledTimes(1);
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it('keeps 3ds_verify unaccepted when no safe challenge URL is stored', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({
        data: boundOtoOrder({
          solidgate_payment_status: '3ds_verify',
          solidgate_verify_url: null,
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: '3ds_verify',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      providerStatus: '3ds_verify',
    });
    expect(body).not.toHaveProperty('nextOto');
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('does not retire the local order from terminal evidence for another customer', async () => {
    mocks.orderMaybeSingle.mockResolvedValueOnce({ data: boundOtoOrder(), error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'different-customer',
        status: 'auth_failed',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'binding_mismatch' });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('recovers Solidgate Support\'s verify_link alias from status when the DB URL is null', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({ data: boundOtoOrder(), error: null })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: '3ds_verify',
        amount: 3000,
        currency: 'eur',
      },
      verify_link: 'https://acs.example/verify/recovered-order-1',
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      requiresAction: true,
      verifyUrl: 'https://acs.example/verify/recovered-order-1',
      orderId: ORDER_ID,
    });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('never falls back to a stored ACS URL when current provider aliases conflict', async () => {
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({
        data: boundOtoOrder({
          solidgate_verify_url: 'https://acs.example/verify/stored-challenge',
        }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { id: 'db-order-1' }, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: '3ds_verify',
        amount: 3000,
        currency: 'eur',
      },
      verify_url: 'https://acs.example/verify/canonical',
      verify_link: 'https://acs.example/verify/conflicting-alias',
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      pending: true,
      accepted: false,
      providerStatus: '3ds_verify',
      orderId: ORDER_ID,
    });
    expect(body).not.toHaveProperty('verifyUrl');
    expect(body).not.toHaveProperty('nextOto');
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('does not retire an order from terminal status with conflicting challenge aliases', async () => {
    mocks.orderMaybeSingle.mockResolvedValueOnce({ data: boundOtoOrder(), error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: 'auth_failed',
        amount: 3000,
        currency: 'eur',
      },
      verify_url: 'https://acs.example/verify/canonical',
      verify_link: 'https://acs.example/verify/conflicting-alias',
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(502);
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('advances when the webhook settles before the accepted-pending CAS', async () => {
    const pending = boundOtoOrder({ solidgate_payment_status: 'creating' });
    const webhookWinner = boundOtoOrder({
      status: 'completed',
      solidgate_payment_status: 'settle_ok',
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    });
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: webhookWinner, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: 'processing',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      orderId: ORDER_ID,
      providerStatus: 'settle_ok',
      settledAmountCents: 3000,
      nextOto: '/oto/4',
    });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment).not.toHaveBeenCalled();
  });

  it('reuses the durable webhook success when it wins before the finalizer CAS', async () => {
    const pending = boundOtoOrder({ solidgate_payment_status: 'creating' });
    const webhookWinner = boundOtoOrder({
      status: 'completed',
      solidgate_payment_status: 'settle_ok',
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    });
    mocks.orderMaybeSingle
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({ data: pending, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: webhookWinner, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: ORDER_ID,
        customer_account_id: 'customer-1',
        status: 'settle_ok',
        amount: 3000,
        currency: 'eur',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto3_bundle_all',
          confirmOrderId: ORDER_ID,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      orderId: ORDER_ID,
      amountCents: 3000,
      nextOto: '/oto/4',
    });
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      p_order_db_id: 'db-order-1',
      p_product_slug: 'BRANDBUNDLE_000000_PDF',
    }));
    expect(mocks.enqueueFulfillment).toHaveBeenCalledWith(expect.objectContaining({
      solidgateOrderId: ORDER_ID,
    }));
  });

  it('wakes the environment-scoped fulfillment drain after enqueueing a captured lifetime OTO', async () => {
    const lifetimeOrderId = arrangeCapturedLifetime();

    const response = await POST(confirmRequest('oto1_lifetime', lifetimeOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      orderId: lifetimeOrderId,
      productSlug: 'oto1_lifetime',
      nextOto: '/oto/2',
    });
    expect(mocks.enqueueFulfillment).toHaveBeenCalledWith(expect.objectContaining({
      paymentEnvironment: 'sandbox',
      solidgateOrderId: lifetimeOrderId,
    }));
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(mocks.drainFulfillment).not.toHaveBeenCalled();
    expect(mocks.enqueueFulfillment.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.after.mock.invocationCallOrder[0]!,
    );

    await mocks.afterCallbacks[0]?.();

    expect(mocks.drainFulfillment).toHaveBeenCalledWith({
      paymentEnvironment: 'sandbox',
      limit: 5,
    });
  });

  it('keeps the captured OTO response successful when the background drain fails', async () => {
    const lifetimeOrderId = arrangeCapturedLifetime();
    const drainError = new Error('worker unavailable');
    mocks.drainFulfillment.mockRejectedValue(drainError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await POST(confirmRequest('oto1_lifetime', lifetimeOrderId));

      expect(response.status).toBe(200);
      expect(mocks.drainFulfillment).not.toHaveBeenCalled();
      expect(mocks.afterCallbacks).toHaveLength(1);
      await expect(mocks.afterCallbacks[0]?.()).resolves.toBeUndefined();
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        orderId: lifetimeOrderId,
        nextOto: '/oto/2',
      });
      expect(consoleError).toHaveBeenCalledWith(
        '[solidgate/charge-oto] background fulfillment drain failed:',
        'worker unavailable',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('confirms a subscription-OTO retry against its stored provider product after catalog drift', async () => {
    const subscriptionOtoOrderId = `${SESSION_ID}:oto2_addon_weekly:1`;
    const subscriptionOto = boundOtoOrder({
      product_name: 'BRANDADDON_000000_SUB',
      solidgate_order_id: subscriptionOtoOrderId,
      product_slug: 'BRANDADDON_000000_SUB',
      amount_cents: 0,
      solidgate_original_amount_cents: 0,
      solidgate_product_id: 'historic-addon-product',
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'oto2',
        session_id: SESSION_ID,
        product_slug: 'oto2_addon_weekly',
        price_id: 'historic-price-id',
      },
      solidgate_subscription_id: null,
      solidgate_payment_status: '3ds_verify',
    });
    mocks.orderMaybeSingle.mockResolvedValue({ data: subscriptionOto, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: subscriptionOtoOrderId,
        customer_account_id: 'customer-1',
        status: 'auth_ok',
        amount: 0,
        currency: 'eur',
        product_id: 'historic-addon-product',
        subscription_id: 'historic-subscription',
      },
    });

    const response = await POST(
      new Request('http://localhost/api/solidgate/charge-oto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          slug: 'oto2_addon_weekly',
          confirmOrderId: subscriptionOtoOrderId,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      orderId: subscriptionOtoOrderId,
      subscriptionId: 'historic-subscription',
      amountCents: 0,
      nextOto: '/oto/3',
    });
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      p_product_slug: 'BRANDADDON_000000_SUB',
      p_solidgate_subscription_id: 'historic-subscription',
    }));
  });
});
