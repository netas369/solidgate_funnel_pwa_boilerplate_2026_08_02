import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enrichmentMocks = vi.hoisted(() => ({
  enrich: vi.fn(),
  prepareWelcome: vi.fn(),
  sendWelcome: vi.fn(),
}));

const metaCapiMocks = vi.hoisted(() => ({
  sendMetaCapiEvent: vi.fn(),
}));

vi.mock('../provision-account', () => ({
  enrichPurchasedAccount: enrichmentMocks.enrich,
}));

vi.mock('@repo/shared/email/send-welcome-email', () => ({
  prepareWelcomeEmail: enrichmentMocks.prepareWelcome,
  sendPreparedWelcomeEmailDetailed: enrichmentMocks.sendWelcome,
}));

vi.mock('@/features/analytics/lib/meta-capi', () => ({
  sendMetaCapiEvent: metaCapiMocks.sendMetaCapiEvent,
  hashMetaEmail: (email: string) => `hashed:${email.trim().toLowerCase()}`,
}));

const {
  drainSolidgateFulfillmentOutbox,
  enqueueCapturedOtoFulfillment,
  enqueueMainPurchaseEnrichment,
} = await import('../solidgate-fulfillment');

const SOURCE_ORDER = {
  id: 'oto-db-id',
  session_id: 'session-1',
  status: 'completed',
  product_slug: 'BRANDPDF5_000000_PDF',
  solidgate_payment_status: 'settle_ok',
  solidgate_refunded_amount_cents: 0,
  solidgate_chargeback_id: null,
  solidgate_chargeback_status: null,
  solidgate_chargeback_amount_cents: 0,
  solidgate_customer_email: 'buyer@example.com',
  solidgate_checkout_locale: 'en',
  solidgate_checkout_identity_legacy: false,
};

// Fresh enough that the 6.5-day CAPI event-window guard never trips in tests.
const RECENT_ORDER_CREATED_AT = new Date(Date.now() - 60_000).toISOString();

const originalResendApiKey = process.env.RESEND_API_KEY;
const originalPwaUrl = process.env.NEXT_PUBLIC_PWA_URL;

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'effect-1',
    attempts: 1,
    claim_token: 'claim-1',
    completed_at: null,
    created_at: '2026-07-21T08:00:00.000Z',
    effect_key: 'send_welcome_email',
    effect_type: 'send_welcome_email',
    environment: 'production',
    last_error: null,
    next_attempt_at: '2026-07-21T08:00:00.000Z',
    payload: {},
    processing_started_at: '2026-07-21T08:01:00.000Z',
    solidgate_order_id: 'session-1:oto5_pdf:1',
    status: 'processing',
    updated_at: '2026-07-21T08:01:00.000Z',
    ...overrides,
  };
}

function makeDrainDb(params: {
  row: ReturnType<typeof claimedRow>;
  source?: Record<string, unknown>;
  mainOrder?: Record<string, unknown> | null;
  persistMainCancellation?: boolean;
  entitlement?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
}) {
  const outbox: Record<string, unknown> = { ...params.row };
  const source = { ...SOURCE_ORDER, ...(params.source ?? {}) };
  const orderUpdates: Record<string, unknown>[] = [];
  let claimResult = [{ ...params.row }];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    let update: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (column: string, value: unknown) => {
      filters[column] = value;
      return chain;
    };
    chain.update = (values: Record<string, unknown>) => {
      update = values;
      return chain;
    };
    chain.maybeSingle = async () => {
      if (table === 'solidgate_fulfillment_outbox' && update) {
        const ownsLease = Object.entries(filters).every(([key, value]) => outbox[key] === value);
        if (!ownsLease) return { data: null, error: null };
        Object.assign(outbox, update);
        return { data: { id: outbox.id }, error: null };
      }
      if (table === 'orders') {
        if (update) {
          if (params.persistMainCancellation === false) {
            return { data: null, error: null };
          }
          orderUpdates.push(update);
          return { data: { id: params.mainOrder?.id ?? 'main-order' }, error: null };
        }
        if (filters.solidgate_subscription_id) {
          return { data: params.mainOrder ?? null, error: null };
        }
        return { data: source, error: null };
      }
      if (table === 'entitlements') return { data: params.entitlement ?? null, error: null };
      if (table === 'sessions') {
        return {
          data: params.session ?? {
            email: 'buyer@example.com',
            user_id: null,
            locale: 'en',
            quiz_answers: {},
          },
          error: null,
        };
      }
      throw new Error(`unexpected maybeSingle ${table}`);
    };
    chain.then = (
      resolve: (value: { data: null; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      if (table === 'orders' && update) orderUpdates.push(update);
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    };
    return chain;
  }

  return {
    db: {
      rpc: async () => {
        const data = claimResult;
        claimResult = [];
        return { data, error: null };
      },
      from: (table: string) => builder(table),
    } as never,
    outbox,
    orderUpdates,
    reclaim(next: ReturnType<typeof claimedRow>) {
      Object.assign(outbox, next);
      claimResult = [{ ...next }];
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 're_test';
  process.env.NEXT_PUBLIC_PWA_URL = 'https://app.example.com';
  delete process.env.META_CAPI_ACCESS_TOKEN;
  process.env.META_PIXEL_ID = '1042049511453137';
  enrichmentMocks.enrich.mockResolvedValue(undefined);
  metaCapiMocks.sendMetaCapiEvent.mockResolvedValue(true);
  enrichmentMocks.prepareWelcome.mockReturnValue({
    from: 'Acme <hello@example.com>',
    to: 'buyer@example.com',
    subject: 'Welcome',
    html: '<p>Welcome</p>',
  });
  enrichmentMocks.sendWelcome.mockResolvedValue({ status: 'sent' });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.META_CAPI_ACCESS_TOKEN;
  delete process.env.META_PIXEL_ID;
  if (originalResendApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendApiKey;
  if (originalPwaUrl === undefined) delete process.env.NEXT_PUBLIC_PWA_URL;
  else process.env.NEXT_PUBLIC_PWA_URL = originalPwaUrl;
});

describe('durable Solidgate fulfillment', () => {
  it('queues main profile, welcome, and CAPI work as independent idempotent effects', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: (table: string) => {
        if (table !== 'solidgate_fulfillment_outbox') throw new Error(`unexpected table ${table}`);
        return { upsert };
      },
    } as never;

    await enqueueMainPurchaseEnrichment({
      supabase: db,
      paymentEnvironment: 'production',
      solidgateOrderId: 'session-1:trial3:1',
      userId: 'user-1',
      sendWelcomeEmail: true,
      metaAttribution: {
        fbp: 'fb.1.111.222',
        fbc: 'fb.1.111.CLICKID',
        client_ip_address: '203.0.113.7',
        client_user_agent: 'TestUA/1.0',
        event_source_url: 'https://funnel.example.com/lt/offer/details',
      },
    });

    expect(upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        effect_type: 'enrich_main_profile',
        effect_key: 'enrich_main_profile',
        payload: { user_id: 'user-1' },
      }),
      expect.objectContaining({
        effect_type: 'send_welcome_email',
        effect_key: 'send_welcome_email',
        payload: { user_id: 'user-1' },
      }),
      expect.objectContaining({
        effect_type: 'send_meta_capi_purchase',
        effect_key: 'send_meta_capi_purchase',
        payload: {
          user_id: 'user-1',
          fbp: 'fb.1.111.222',
          fbc: 'fb.1.111.CLICKID',
          client_ip_address: '203.0.113.7',
          client_user_agent: 'TestUA/1.0',
          event_source_url: 'https://funnel.example.com/lt/offer/details',
        },
      }),
    ], {
      onConflict: 'environment,solidgate_order_id,effect_key',
      ignoreDuplicates: true,
    });
  });

  it('sends the server-side CAPI Purchase with the browser dedup id and stored attribution', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-test';
    const row = claimedRow({
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      solidgate_order_id: 'session-1:trial3:1',
      payload: {
        user_id: 'user-1',
        fbp: 'fb.1.111.222',
        fbc: 'fb.1.111.CLICKID',
        client_ip_address: '203.0.113.7',
        client_user_agent: 'TestUA/1.0',
        event_source_url: 'https://funnel.example.com/lt/offer/details',
      },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        solidgate_customer_email: 'paid-buyer@example.com',
        solidgate_checkout_locale: 'lt',
        amount_cents: 500,
        solidgate_original_amount_cents: 500,
        currency: 'eur',
        created_at: RECENT_ORDER_CREATED_AT,
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: {
        email: 'paid-buyer@example.com',
        user_id: 'user-1',
        locale: 'lt',
        quiz_answers: {},
      },
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });

    expect(metaCapiMocks.sendMetaCapiEvent).toHaveBeenCalledWith({
      eventName: 'Purchase',
      eventId: 'purchase:session-1:trial3:1',
      eventSourceUrl: 'https://funnel.example.com/lt/offer/details',
      eventTimeSec: Math.floor(Date.parse(RECENT_ORDER_CREATED_AT) / 1000),
      userData: {
        em: 'hashed:paid-buyer@example.com',
        fbp: 'fb.1.111.222',
        fbc: 'fb.1.111.CLICKID',
        client_ip_address: '203.0.113.7',
        client_user_agent: 'TestUA/1.0',
      },
      customData: {
        value: 5,
        currency: 'EUR',
        content_type: 'product',
      },
    });
  });

  it('completes the CAPI effect as a no-op while the access token is not provisioned', async () => {
    const row = claimedRow({
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        amount_cents: 500,
        solidgate_original_amount_cents: 500,
        currency: 'eur',
        created_at: RECENT_ORDER_CREATED_AT,
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: { email: 'buyer@example.com', user_id: 'user-1', locale: 'en', quiz_answers: {} },
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(metaCapiMocks.sendMetaCapiEvent).not.toHaveBeenCalled();
  });

  it('keeps a failed CAPI delivery retryable in the fulfillment outbox', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-test';
    metaCapiMocks.sendMetaCapiEvent.mockResolvedValueOnce(false);
    const row = claimedRow({
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        amount_cents: 500,
        solidgate_original_amount_cents: 500,
        currency: 'eur',
        created_at: RECENT_ORDER_CREATED_AT,
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: { email: 'buyer@example.com', user_id: 'user-1', locale: 'en', quiz_answers: {} },
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('meta capi purchase delivery failed');
    expect(memory.outbox).toMatchObject({
      status: 'failed',
      claim_token: null,
      last_error: 'meta capi purchase delivery failed',
    });
  });

  it('completes the CAPI effect as a no-op when the pixel id is missing despite a token', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-test';
    const originalPublicPixel = process.env.NEXT_PUBLIC_META_PIXEL_ID;
    delete process.env.META_PIXEL_ID;
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    try {
      const row = claimedRow({
        effect_type: 'send_meta_capi_purchase',
        effect_key: 'send_meta_capi_purchase',
        solidgate_order_id: 'session-1:trial3:1',
        payload: { user_id: 'user-1' },
      });
      const memory = makeDrainDb({
        row,
        source: {
          user_id: 'user-1',
          status: 'trialing',
          product_slug: 'BRAND_000000_SUB',
          amount_cents: 500,
          solidgate_original_amount_cents: 500,
          currency: 'eur',
          created_at: RECENT_ORDER_CREATED_AT,
        },
        entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
        session: { email: 'buyer@example.com', user_id: 'user-1', locale: 'en', quiz_answers: {} },
      });

      await expect(drainSolidgateFulfillmentOutbox({
        supabase: memory.db,
        client: {} as never,
        paymentEnvironment: 'production',
      })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
      expect(metaCapiMocks.sendMetaCapiEvent).not.toHaveBeenCalled();
    } finally {
      if (originalPublicPixel !== undefined) {
        process.env.NEXT_PUBLIC_META_PIXEL_ID = originalPublicPixel;
      }
    }
  });

  it('parks a CAPI row older than the 7-day Meta event window for manual review', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-test';
    const row = claimedRow({
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        amount_cents: 500,
        solidgate_original_amount_cents: 500,
        currency: 'eur',
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: { email: 'buyer@example.com', user_id: 'user-1', locale: 'en', quiz_answers: {} },
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('meta capi purchase is beyond the 7-day event window');
    expect(metaCapiMocks.sendMetaCapiEvent).not.toHaveBeenCalled();
    expect(memory.outbox).toMatchObject({ status: 'manual_review' });
  });

  it('escalates a CAPI row to manual review once delivery retries are exhausted', async () => {
    process.env.META_CAPI_ACCESS_TOKEN = 'token-test';
    metaCapiMocks.sendMetaCapiEvent.mockResolvedValueOnce(false);
    const row = claimedRow({
      attempts: 24,
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        amount_cents: 500,
        solidgate_original_amount_cents: 500,
        currency: 'eur',
        created_at: RECENT_ORDER_CREATED_AT,
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: { email: 'buyer@example.com', user_id: 'user-1', locale: 'en', quiz_answers: {} },
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('meta capi purchase delivery exhausted retries');
    expect(memory.outbox).toMatchObject({ status: 'manual_review' });
  });

  it('runs post-purchase enrichment after rechecking the captured main entitlement', async () => {
    const row = claimedRow({
      effect_type: 'enrich_main_profile',
      effect_key: 'enrich_main_profile',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const session = {
      email: 'buyer@example.com',
      user_id: 'user-1',
      locale: 'lt',
      quiz_answers: { fullName: 'Buyer' },
    };
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
        solidgate_checkout_locale: 'lt',
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session,
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(enrichmentMocks.enrich).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      userId: 'user-1',
      session,
    }));
  });

  it('still enriches a captured main buyer after OTO1 replaces and cancels the recurring plan', async () => {
    const row = claimedRow({
      effect_type: 'enrich_main_profile',
      effect_key: 'enrich_main_profile',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const session = {
      email: 'mutable-profile@example.com',
      user_id: 'user-1',
      locale: 'en',
      quiz_answers: { fullName: 'Lifetime Buyer' },
    };
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'canceled',
        product_slug: 'BRAND_000000_SUB',
        solidgate_payment_status: 'settle_ok',
        solidgate_refunded_amount_cents: 0,
        solidgate_customer_email: 'paid-buyer@example.com',
        solidgate_checkout_locale: 'lt',
      },
      // A later subscription.cancel callback may already have closed the main
      // entitlement; that lifecycle state does not undo the captured purchase.
      entitlement: {
        user_id: 'user-1',
        status: 'canceled',
        revoked_at: '2026-07-21T09:00:00.000Z',
      },
      session,
    });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(enrichmentMocks.enrich).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({
        email: 'paid-buyer@example.com',
        locale: 'lt',
      }),
    }));
  });

  it('retries an ambiguous welcome send with one stable body and idempotency key', async () => {
    const row = claimedRow({
      effect_type: 'send_welcome_email',
      effect_key: 'send_welcome_email',
      solidgate_order_id: 'session-1:trial3:1',
      payload: { user_id: 'user-1' },
    });
    const memory = makeDrainDb({
      row,
      source: {
        user_id: 'user-1',
        status: 'trialing',
        product_slug: 'BRAND_000000_SUB',
      },
      entitlement: { user_id: 'user-1', status: 'active', revoked_at: null },
      session: {
        email: 'buyer@example.com',
        user_id: 'user-1',
        locale: 'lt',
        quiz_answers: {},
      },
    });
    enrichmentMocks.sendWelcome
      .mockResolvedValueOnce({ status: 'ambiguous', error: 'response timeout' })
      .mockResolvedValueOnce({ status: 'sent' });

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('welcome email delivery failed');
    const persistedPayload = memory.outbox.payload as Record<string, unknown>;
    expect(persistedPayload).toMatchObject({
      user_id: 'user-1',
      prepared_message: {
        to: 'buyer@example.com',
        subject: 'Welcome',
      },
      delivery_ambiguous_at: expect.any(String),
    });

    memory.reclaim(claimedRow({
      attempts: 2,
      claim_token: 'claim-2',
      effect_type: 'send_welcome_email',
      effect_key: 'send_welcome_email',
      solidgate_order_id: 'session-1:trial3:1',
      payload: persistedPayload,
    }));
    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: {} as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });

    expect(enrichmentMocks.prepareWelcome).toHaveBeenCalledTimes(1);
    expect(enrichmentMocks.sendWelcome).toHaveBeenCalledTimes(2);
    expect(enrichmentMocks.sendWelcome).toHaveBeenNthCalledWith(1, expect.objectContaining({
      idempotencyKey: 'welcome:session-1:trial3:1',
    }));
    expect(enrichmentMocks.sendWelcome).toHaveBeenNthCalledWith(2, expect.objectContaining({
      idempotencyKey: 'welcome:session-1:trial3:1',
    }));
  });

  it('does not mark a main plan canceled when a 2xx provider body reports an error', async () => {
    const row = claimedRow({
      effect_type: 'cancel_main_subscription',
      effect_key: 'cancel_main_subscription:sub-main',
      payload: { subscription_id: 'sub-main' },
    });
    const memory = makeDrainDb({
      row,
      source: { product_slug: 'BRANDLIFETIME_000000_SUB' },
      mainOrder: {
        id: 'main-order',
        product_slug: 'BRAND_000000_SUB',
        session_id: 'session-1',
      },
    });
    const client = {
      subscriptionStatus: vi.fn()
        .mockResolvedValueOnce({ subscription: { status: 'active' } })
        .mockResolvedValueOnce({ subscription: { status: 'active' } }),
      cancelSubscription: vi.fn().mockResolvedValue({
        error: { code: '4.01', recommended_message_for_user: 'not canceled' },
      }),
    };

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: client as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('remains active');
    expect(memory.orderUpdates).not.toContainEqual(expect.objectContaining({ status: 'canceled' }));
    expect(memory.outbox.status).toBe('failed');
  });

  it('retries the main-plan cancellation while the replaced order is still pending capture recognition', async () => {
    const row = claimedRow({
      effect_type: 'cancel_main_subscription',
      effect_key: 'cancel_main_subscription:sub-main',
      payload: { subscription_id: 'sub-main' },
    });
    const memory = makeDrainDb({
      row,
      source: { product_slug: 'BRANDLIFETIME_000000_SUB' },
      mainOrder: {
        id: 'main-order',
        product_slug: 'BRAND_000000_SUB',
        session_id: 'session-1',
        status: 'pending',
      },
    });
    const client = {
      subscriptionStatus: vi.fn(),
      cancelSubscription: vi.fn(),
    };

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: client as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('pending capture recognition');
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    expect(memory.orderUpdates).not.toContainEqual(expect.objectContaining({ status: 'canceled' }));
    expect(memory.outbox.status).toBe('failed');
  });

  it('never calls the provider after a cancellation claim has been reclaimed', async () => {
    const row = claimedRow({
      effect_type: 'cancel_main_subscription',
      effect_key: 'cancel_main_subscription:sub-main',
      payload: { subscription_id: 'sub-main' },
    });
    const memory = makeDrainDb({
      row,
      source: { product_slug: 'BRANDLIFETIME_000000_SUB' },
      mainOrder: {
        id: 'main-order',
        product_slug: 'BRAND_000000_SUB',
        session_id: 'session-1',
      },
    });
    memory.outbox.claim_token = 'newer-claim';
    const client = {
      subscriptionStatus: vi.fn(),
      cancelSubscription: vi.fn(),
    };

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: client as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 0, failed: 0 });
    expect(client.subscriptionStatus).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it('reconciles a lost cancellation response before persisting local cancellation', async () => {
    const row = claimedRow({
      effect_type: 'cancel_main_subscription',
      effect_key: 'cancel_main_subscription:sub-main',
      payload: { subscription_id: 'sub-main' },
    });
    const memory = makeDrainDb({
      row,
      source: { product_slug: 'BRANDLIFETIME_000000_SUB' },
      mainOrder: {
        id: 'main-order',
        product_slug: 'BRAND_000000_SUB',
        session_id: 'session-1',
      },
    });
    const client = {
      subscriptionStatus: vi.fn()
        .mockResolvedValueOnce({ subscription: { status: 'active' } })
        .mockResolvedValueOnce({ subscription: { status: 'canceled' } }),
      cancelSubscription: vi.fn().mockRejectedValue(new Error('response timeout')),
    };

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: client as never,
      paymentEnvironment: 'production',
    })).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(memory.orderUpdates).toContainEqual({ status: 'canceled' });
    expect(memory.outbox.status).toBe('completed');
  });

  it('does not complete when the provider canceled but the bound local order update matched zero rows', async () => {
    const row = claimedRow({
      effect_type: 'cancel_main_subscription',
      effect_key: 'cancel_main_subscription:sub-main',
      payload: { subscription_id: 'sub-main' },
    });
    const memory = makeDrainDb({
      row,
      source: { product_slug: 'BRANDLIFETIME_000000_SUB' },
      mainOrder: {
        id: 'main-order',
        product_slug: 'BRAND_000000_SUB',
        session_id: 'session-1',
      },
      persistMainCancellation: false,
    });
    const client = {
      subscriptionStatus: vi.fn()
        .mockResolvedValueOnce({ subscription: { status: 'active' } })
        .mockResolvedValueOnce({ subscription: { status: 'canceled' } }),
      cancelSubscription: vi.fn().mockResolvedValue({ subscription: { status: 'canceled' } }),
    };

    await expect(drainSolidgateFulfillmentOutbox({
      supabase: memory.db,
      client: client as never,
      paymentEnvironment: 'production',
    })).rejects.toThrow('persist matched no row');
    expect(memory.orderUpdates).toHaveLength(0);
    expect(memory.outbox.status).toBe('failed');
  });

  it('queues nothing for an OTO whose capture was partially refunded', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const source = {
      ...SOURCE_ORDER,
      solidgate_refunded_amount_cents: 100,
    };
    const db = {
      from: (table: string) => {
        if (table === 'orders') {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = async () => ({ data: source, error: null });
          return chain;
        }
        if (table === 'solidgate_fulfillment_outbox') return { upsert };
        throw new Error(`unexpected table ${table}`);
      },
    } as never;

    await enqueueCapturedOtoFulfillment({
      supabase: db,
      paymentEnvironment: 'production',
      solidgateOrderId: 'session-1:oto5_pdf:1',
    });
    expect(upsert).not.toHaveBeenCalled();
  });
});
