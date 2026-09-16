import { describe, expect, it, vi, beforeEach } from 'vitest';
import { routing } from '@repo/i18n/routing';
import catalogIds from '@repo/shared/solidgate/catalog-ids.json';

// The shipped catalog-ids.json is scrubbed to empty strings (see the fixture
// module); seed it so these suites reach the payment logic under test.
vi.mock('@repo/shared/solidgate/catalog-ids.json', async () => {
  const { SEEDED_CATALOG_IDS } = await import('./_seeded-catalog-ids');
  return { default: SEEDED_CATALOG_IDS };
});


// The gates that stand between a request and money.

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const MAIN_PRODUCT = 'BRAND_000000_SUB';
const TRIAL1_EUR_PRICE_ID = catalogIds.trial1.prices.eur;

const mockSession = {
  locale: 'lt',
  email: 'buyer@example.com',
  user_id: null as string | null,
};

type MockOrder = {
  id: string;
  psp: 'solidgate';
  payment_environment: 'sandbox' | 'production';
  solidgate_order_id: string;
  session_id: string;
  user_id: string | null;
  status: string;
  amount_cents: number;
  solidgate_original_amount_cents: number | null;
  currency: string;
  product_name: string;
  product_slug: string;
  solidgate_payment_status: string | null;
  solidgate_customer_email: string;
  solidgate_checkout_locale: string;
  solidgate_product_id: string;
  solidgate_payment_action: 'auth_settle' | 'auth_0_amount';
  tracking_metadata: Record<string, unknown>;
};

type MockMerchantData = {
  merchant: string;
  paymentIntent: string;
  signature: string;
};

const state = {
  session: mockSession as typeof mockSession | null,
  sessionError: null as { message: string } | null,
  openRpcError: null as { code?: string; message: string } | null,
  finalizeRpcError: null as { code?: string; message: string } | null,
  insertedOrders: [] as MockOrder[],
  priorEntitlements: [] as { id: string }[],
  entitlementError: null as { message: string } | null,
  authUserId: null as string | null,
  authLookupError: null as { message: string } | null,
  introClaimResult: 'claimed' as 'claimed' | 'retry' | 'already_used' | 'in_progress' | 'unexpected',
  introClaimError: null as { message: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  reservationOverrides: {} as Record<string, unknown>,
  checkoutState: null as null | {
    orderDbId: string;
    offerSlug: string;
    builderToken: string;
    merchantData: MockMerchantData | null;
  },
  openBarrier: null as null | {
    parties: number;
    arrived: number;
    promise: Promise<void>;
    release: () => void;
  },
};

let nextOrderNumber = 1;
let atomicTail = Promise.resolve();

function mockOrderId(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
}

async function withAtomicLock<T>(work: () => T | Promise<T>): Promise<T> {
  const previous = atomicTail;
  let release = () => {};
  atomicTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function installOpenBarrier(parties = 2): void {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.openBarrier = { parties, arrived: 0, promise, release };
}

async function meetOpenBarrier(): Promise<void> {
  const barrier = state.openBarrier;
  if (!barrier) return;
  barrier.arrived += 1;
  if (barrier.arrived >= barrier.parties) barrier.release();
  await barrier.promise;
}

function seedOrder(overrides: Partial<MockOrder> = {}): MockOrder {
  const offerSlug = (overrides.tracking_metadata?.product_slug as string | undefined) ?? 'trial1';
  const order: MockOrder = {
    id: mockOrderId(nextOrderNumber++),
    psp: 'solidgate',
    payment_environment: 'sandbox',
    solidgate_order_id: `${SESSION_ID}:${offerSlug}:1`,
    session_id: SESSION_ID,
    user_id: null,
    status: 'pending',
    amount_cents: 500,
    solidgate_original_amount_cents: null,
    currency: 'eur',
    product_name: MAIN_PRODUCT,
    product_slug: MAIN_PRODUCT,
    solidgate_payment_status: null,
    solidgate_customer_email: 'buyer@example.com',
    solidgate_checkout_locale: 'lt',
    solidgate_product_id: catalogIds.trial1.product_id,
    solidgate_payment_action: 'auth_settle',
    tracking_metadata: {
      funnel_code: 'BRAND',
      funnel_variant: 'main',
      session_id: SESSION_ID,
      product_slug: offerSlug,
      price_id: TRIAL1_EUR_PRICE_ID,
    },
    ...overrides,
  };
  state.insertedOrders.push(order);
  return order;
}

function reservationFor(
  order: MockOrder,
  args: Record<string, unknown>,
  isNew: boolean,
): Record<string, unknown> {
  const builderToken = args.p_builder_token as string;
  const offerSlug = args.p_offer_slug as string;
  if (
    !state.checkoutState ||
    state.checkoutState.orderDbId !== order.id ||
    !state.insertedOrders.some((candidate) => candidate.id === state.checkoutState?.orderDbId)
  ) {
    state.checkoutState = {
      orderDbId: order.id,
      offerSlug,
      builderToken,
      merchantData: null,
    };
  }
  const checkout = state.checkoutState;
  return {
    order_db_id: order.id,
    solidgate_order_id: order.solidgate_order_id,
    bound_session_id: order.session_id,
    bound_payment_environment: order.payment_environment,
    bound_product_slug: order.product_slug,
    bound_product_name: order.product_name,
    bound_offer_slug: checkout.offerSlug,
    bound_amount_cents: order.amount_cents,
    bound_currency: order.currency,
    bound_order_status: order.status,
    bound_payment_status: order.solidgate_payment_status,
    bound_tracking_metadata: order.tracking_metadata,
    bound_customer_email: order.solidgate_customer_email,
    bound_checkout_locale: order.solidgate_checkout_locale,
    bound_solidgate_product_id: order.solidgate_product_id,
    bound_solidgate_payment_action: order.solidgate_payment_action,
    is_new: isNew,
    should_build: checkout.merchantData === null && checkout.builderToken === builderToken,
    merchant_data: checkout.merchantData,
    ...state.reservationOverrides,
  };
}

async function openMainCheckout(args: Record<string, unknown>) {
  await meetOpenBarrier();
  return withAtomicLock(async () => {
    if (state.openRpcError) return { data: null, error: state.openRpcError };
    const environment = args.p_payment_environment as 'sandbox' | 'production';
    const sessionId = args.p_session_id as string;
    const productSlug = args.p_product_slug as string;
    const offerSlug = args.p_offer_slug as string;
    const candidates = state.insertedOrders.filter(
      (order) =>
        order.payment_environment === environment &&
        order.session_id === sessionId &&
        order.psp === 'solidgate' &&
        order.product_slug === productSlug,
    );
    const open = candidates.filter((order) => order.status === 'pending');
    if (open.length > 1) {
      return { data: null, error: { code: '23505', message: 'multiple payable orders' } };
    }
    if (open.length === 1) return { data: [reservationFor(open[0], args, false)], error: null };
    if (candidates.some((order) => order.status !== 'failed')) {
      return { data: null, error: { code: '23514', message: 'checkout is not retryable' } };
    }
    if (
      candidates.some(
        (order) =>
          !order.solidgate_payment_status ||
          !['auth_failed', 'declined', 'void_ok'].includes(order.solidgate_payment_status),
      )
    ) {
      return { data: null, error: { code: '23514', message: 'failed order is not terminal' } };
    }
    const attempts = candidates.map((order) => Number(order.solidgate_order_id.split(':').at(-1)) || 0);
    const attempt = Math.max(0, ...attempts) + 1;
    const order = seedOrder({
      payment_environment: environment,
      solidgate_order_id: `${sessionId}:${offerSlug}:${attempt}`,
      session_id: sessionId,
      user_id: (args.p_user_id as string | null) ?? null,
      amount_cents: args.p_amount_cents as number,
      currency: args.p_currency as string,
      product_name: args.p_product_name as string,
      product_slug: productSlug,
      solidgate_customer_email: args.p_customer_email as string,
      solidgate_checkout_locale: args.p_checkout_locale as string,
      solidgate_product_id: args.p_solidgate_product_id as string,
      solidgate_payment_action: args.p_solidgate_payment_action as 'auth_settle' | 'auth_0_amount',
      tracking_metadata: args.p_tracking_metadata as Record<string, unknown>,
    });
    return { data: [reservationFor(order, args, true)], error: null };
  });
}

async function finalizeMainCheckout(args: Record<string, unknown>) {
  return withAtomicLock(async () => {
    if (state.finalizeRpcError) return { data: null, error: state.finalizeRpcError };
    const checkout = state.checkoutState;
    if (
      !checkout ||
      checkout.orderDbId !== args.p_order_db_id ||
      checkout.builderToken !== args.p_builder_token
    ) {
      return { data: null, error: { code: '40001', message: 'builder lost ownership' } };
    }
    checkout.merchantData = args.p_merchant_data as MockMerchantData;
    return { data: checkout.merchantData, error: null };
  });
}

vi.mock('@repo/shared/solidgate', async () => {
  const actual = await vi.importActual<typeof import('@repo/shared/solidgate')>('@repo/shared/solidgate');
  return {
    ...actual,
    buildFormMerchantData: vi.fn(async (publicKey: string, _secretKey: string, intent: unknown) => ({
      merchant: publicKey,
      signature: 'test_signature',
      paymentIntent: JSON.stringify(intent),
    })),
  };
});

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table === 'sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.session, error: state.sessionError }),
            }),
          }),
        };
      }
      if (table === 'orders') {
        throw new Error('create-session must not read or insert orders outside the atomic RPC');
      }
      if (table === 'entitlements') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                or: () => ({
                  limit: async () => ({ data: state.priorEntitlements, error: state.entitlementError }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === 'find_auth_user_id_by_email') {
        return { data: state.authUserId, error: state.authLookupError };
      }
      if (name === 'claim_solidgate_intro_offer') {
        return { data: state.introClaimResult, error: state.introClaimError };
      }
      if (name === 'get_solidgate_main_checkout_identity') {
        const checkout = state.checkoutState;
        const order = checkout
          ? state.insertedOrders.find((candidate) => candidate.id === checkout.orderDbId)
          : null;
        return {
          data: checkout && order
            ? [{
                order_db_id: order.id,
                offer_slug: checkout.offerSlug,
                customer_email: order.solidgate_customer_email,
                checkout_locale: order.solidgate_checkout_locale,
                solidgate_product_id: order.solidgate_product_id,
                solidgate_payment_action: order.solidgate_payment_action,
                amount_cents: order.amount_cents,
                currency: order.currency,
                tracking_metadata: order.tracking_metadata,
                user_id: order.user_id,
              }]
            : [],
          error: null,
        };
      }
      if (name === 'open_solidgate_main_checkout_v2') return openMainCheckout(args);
      if (name === 'finalize_solidgate_main_checkout_v2') return finalizeMainCheckout(args);
      throw new Error(`unexpected rpc ${name}`);
    },
  }),
}));

const solidgate = await import('@repo/shared/solidgate');
const buildFormMerchantDataMock = vi.mocked(solidgate.buildFormMerchantData);
const { POST } = await import('../create-session/route');

function post(body: unknown, headers?: HeadersInit) {
  return POST(
    new Request('http://localhost/api/solidgate/create-session', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.session = { ...mockSession };
  state.sessionError = null;
  state.openRpcError = null;
  state.finalizeRpcError = null;
  state.insertedOrders = [];
  state.priorEntitlements = [];
  state.entitlementError = null;
  state.authUserId = null;
  state.authLookupError = null;
  state.introClaimResult = 'claimed';
  state.introClaimError = null;
  state.rpcCalls = [];
  state.reservationOverrides = {};
  state.checkoutState = null;
  state.openBarrier = null;
  nextOrderNumber = 1;
  atomicTail = Promise.resolve();
  buildFormMerchantDataMock.mockClear();
  process.env.SOLIDGATE_API_PUBLIC_KEY = 'api_pk_test';
  process.env.SOLIDGATE_API_SECRET_KEY = 'api_sk_test_secret_0123456789abcdefghij';
  process.env.SOLIDGATE_ENVIRONMENT = 'sandbox';
  process.env.ENABLED_CHECKOUT_LOCALES = 'en,lt';
  delete process.env.VERCEL_ENV;
});

describe('solidgate create-session gates', () => {
  it.each(['trial1', 'trial2', 'trial3', 'trial4', 'special_1eur', 'special_free'])(
    'uses the static channel descriptor for %s while preserving locale order descriptions',
    async (productId) => {
      const response = await post({ productId, sessionId: SESSION_ID });

      expect(response.status).toBe(200);
      expect(buildFormMerchantDataMock).toHaveBeenCalledTimes(1);
      const intent = buildFormMerchantDataMock.mock.calls[0][2];
      expect(intent).not.toHaveProperty('dynamic_descriptor');
      expect(intent.order_description).toBe(`LT_${MAIN_PRODUCT}`);
      expect(intent.order_metadata).toMatchObject({ product_slug: productId });
    },
  );

  it('rejects an unknown product', async () => {
    const res = await post({ productId: 'not_a_tier', sessionId: SESSION_ID });
    expect(res.status).toBe(400);
  });

  it('rejects trial_monthly — the rebill price is never sold at checkout', async () => {
    const res = await post({ productId: 'trial_monthly', sessionId: SESSION_ID });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed sessionId', async () => {
    const res = await post({ productId: 'trial1', sessionId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('requires an email before payment', async () => {
    state.session = { ...mockSession, email: '' };
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('EMAIL_REQUIRED');
  });

  it('blocks a repeat free trial (409)', async () => {
    state.priorEntitlements = [{ id: 'ent-1' }];
    state.authUserId = 'u1';
    const res = await post({ productId: 'special_free', sessionId: SESSION_ID });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INTRO_OFFER_ALREADY_USED');
  });

  it.each(['trial1', 'trial2', 'trial3', 'trial4', 'special_1eur'])(
    'blocks a second introductory subscription through %s (409)',
    async (productId) => {
      state.priorEntitlements = [{ id: 'ent-1' }];
      state.authUserId = 'u1';

      const res = await post({ productId, sessionId: SESSION_ID });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('INTRO_OFFER_ALREADY_USED');
      expect(state.insertedOrders).toHaveLength(0);
    },
  );

  it('uses the indexed auth lookup before deciding trial eligibility', async () => {
    state.authUserId = 'buyer-id';
    state.priorEntitlements = [{ id: 'ent-1' }];
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(409);
    expect(state.rpcCalls).toContainEqual({
      name: 'find_auth_user_id_by_email',
      args: { p_email: 'buyer@example.com' },
    });
  });

  it('atomically blocks a concurrent introductory checkout from another session/tier', async () => {
    state.introClaimResult = 'in_progress';

    const res = await post({ productId: 'trial3', sessionId: SESSION_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INTRO_OFFER_IN_PROGRESS' });
    expect(state.insertedOrders).toHaveLength(0);
    expect(state.rpcCalls).toContainEqual({
      name: 'claim_solidgate_intro_offer',
      args: expect.objectContaining({
        p_payment_environment: 'sandbox',
        p_session_id: SESSION_ID,
        p_tier: 'trial3',
        p_email_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
  });

  it('blocks a permanently consumed introductory claim', async () => {
    state.introClaimResult = 'already_used';

    const res = await post({ productId: 'special_1eur', sessionId: SESSION_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'INTRO_OFFER_ALREADY_USED' });
    expect(state.insertedOrders).toHaveLength(0);
  });

  it('fails closed when the atomic introductory claim cannot be verified', async () => {
    state.introClaimError = { message: 'database unavailable' };

    const res = await post({ productId: 'trial2', sessionId: SESSION_ID });

    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(0);
  });

  it('fails closed when repeat-trial eligibility cannot be verified', async () => {
    state.authLookupError = { message: 'auth unavailable' };
    const res = await post({ productId: 'trial4', sessionId: SESSION_ID });
    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(0);
  });

  it('fails closed: no intent is issued if the order binding cannot be written', async () => {
    state.openRpcError = { message: 'db down' };
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.merchantData).toBeUndefined();
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('prices from the session locale, never the request, and binds the order first', async () => {
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(200);
    const body = await res.json();

    // lt → eur, trial1 → 500 minor units.
    const order = state.insertedOrders[0];
    expect(order.currency).toBe('eur');
    expect(order.amount_cents).toBe(500);
    expect(order.status).toBe('pending');
    expect(order.psp).toBe('solidgate');
    expect(order.product_slug).toBe('BRAND_000000_SUB');
    expect(order.solidgate_order_id).toBe(`${SESSION_ID}:trial1:1`);

    // The intent is opaque to the client: encrypted + signed, no amount to tamper with.
    expect(body.merchantData.merchant).toBe('api_pk_test');
    expect(body.merchantData.paymentIntent).toEqual(expect.any(String));
    expect(body.merchantData.signature).toEqual(expect.any(String));
    expect(body.orderId).toBe(`${SESSION_ID}:trial1:1`);
  });

  it('reuses the order-bound email and locale after the session changes during checkout', async () => {
    const first = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    state.session = {
      ...mockSession,
      email: 'changed@example.com',
      locale: 'en',
    };
    const second = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(secondBody.merchantData).toEqual(firstBody.merchantData);
    expect(state.insertedOrders).toHaveLength(1);
    const opens = state.rpcCalls.filter((call) => call.name === 'open_solidgate_main_checkout_v2');
    expect(opens.at(-1)?.args).toMatchObject({
      p_customer_email: 'buyer@example.com',
      p_checkout_locale: 'lt',
      p_currency: 'eur',
    });
    const intent = JSON.parse(firstBody.merchantData.paymentIntent) as {
      customer_email: string;
      language: string;
    };
    expect(intent.customer_email).toBe('buyer@example.com');
    expect(intent.language).toBe('lt');
  });

  it('replays immutable order pricing and price metadata after the live catalog changes', async () => {
    const legacyPriceId = 'price-created-by-an-earlier-catalog-deploy';
    const order = seedOrder({
      amount_cents: 4321,
      currency: 'usd',
      solidgate_customer_email: 'original@example.com',
      solidgate_checkout_locale: 'en',
      solidgate_product_id: 'product-created-by-an-earlier-catalog-deploy',
      tracking_metadata: {
        funnel_code: 'BRAND',
        funnel_variant: 'main',
        session_id: SESSION_ID,
        product_slug: 'trial1',
        price_id: legacyPriceId,
      },
    });
    const cachedMerchantData = {
      merchant: 'api_pk_test',
      paymentIntent: 'immutable-legacy-intent',
      signature: 'immutable-legacy-signature',
    };
    state.checkoutState = {
      orderDbId: order.id,
      offerSlug: 'trial1',
      builderToken: mockOrderId(998),
      merchantData: cachedMerchantData,
    };
    state.session = { ...mockSession, email: 'changed@example.com', locale: 'lt' };

    const response = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(response.status).toBe(200);
    expect(state.rpcCalls.findLast((call) => call.name === 'open_solidgate_main_checkout_v2')?.args)
      .toMatchObject({
        p_amount_cents: 4321,
        p_currency: 'usd',
        p_customer_email: 'original@example.com',
        p_checkout_locale: 'en',
        p_tracking_metadata: order.tracking_metadata,
        p_solidgate_product_id: 'product-created-by-an-earlier-catalog-deploy',
        p_solidgate_payment_action: 'auth_settle',
      });
    await expect(response.json()).resolves.toMatchObject({ merchantData: cachedMerchantData });
  });

  it('sends canonical attribution and product context without exceeding metadata cap', async () => {
    const res = await post({
      productId: 'trial3',
      sessionId: SESSION_ID,
      attribution: {
        first_touch: {
          utm_source: 'fb',
          utm_medium: 'Facebook_Mobile_Feed',
          utm_campaign: 'Campaign A',
          utm_content: 'Creative 7',
          utm_term: 'Broad',
          fbclid: 'first-click',
          landing_url: 'https://funnel.example.com/lt?utm_source=fb',
        },
        last_touch: { utm_source: 'instagram', fbclid: 'last-click' },
        fbc: 'fb.1.123.last-click',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const intent = JSON.parse(body.merchantData.paymentIntent) as Record<string, unknown>;
    expect(intent.traffic_source).toBe('instagram');
    expect(intent.transaction_source).toBe('funnel:main');
    expect(intent.website).toBe('http://localhost');
    expect(intent.apple_pay_merchant_name).toBe('Acme');
    expect(intent.order_metadata).toEqual({
      funnel_code: 'BRAND',
      funnel_variant: 'main',
      session_id: SESSION_ID,
      product_slug: 'trial3',
      price_id: expect.any(String),
      utm_source: 'fb',
      utm_medium: 'Facebook_Mobile_Feed',
      utm_campaign: 'Campaign A',
      utm_content: 'Creative 7',
      utm_term: 'Broad',
    });
    expect(Object.keys(intent.order_metadata as object)).toHaveLength(10);
    expect(body.tracking).toMatchObject({
      funnel_code: 'BRAND',
      funnel_variant: 'main',
      product: 'trial3',
      product_id: 'BRAND_000000_SUB',
      product_slug: 'trial3',
      product_code: 'BRAND_000000_SUB',
      product_name: 'Main Subscription (trial3)',
      amount_cents: 1300,
      currency: 'EUR',
    });
    expect(body.tracking.solidgate_product_id).toEqual(expect.any(String));
    expect(body.tracking.price_id).toEqual(expect.any(String));
  });

  it('returns 3DS redirects to the page that sold: variant-aware success_url', async () => {
    const cases: Array<[string, string]> = [
      ['trial1', '/lt/offer/details'],
      ['special_1eur', '/lt/special-offer'],
      ['special_free', '/lt/special-offer-free'],
    ];
    for (const [productId, path] of cases) {
      state.insertedOrders = [];
      const res = await post({ productId, sessionId: SESSION_ID });
      expect(res.status).toBe(200);
      const body = await res.json();
      const intent = JSON.parse(body.merchantData.paymentIntent) as { success_url: string };
      expect(intent.success_url).toBe(
        `http://localhost${path}?sg_order=${encodeURIComponent(`${SESSION_ID}:${productId}:1`)}`,
      );
    }
  });

  /**
   * The regression this file shipped: success_url was interpolated from the
   * locale IDENTIFIER, but six locales route under a country code (cs→/cz,
   * da→/dk, zh-TW→/tw, el→/gr, he→/il, ja→/jp) and the default locale is
   * unprefixed. Those buyers' redirect-3DS return landed on a path matching no
   * route, so our 404 rendered inside the payment iframe and the sg_order grant
   * never ran. Asserting only 'lt' — one of the nine locales where identifier
   * and prefix happen to coincide — is exactly what let it through.
   */
  it('builds success_url from the routable locale prefix, not the locale id', async () => {
    // Oracle is routing.localePrefix — what next-intl serves. Deriving it from
    // LOCALE_URL_PREFIX (the table the route consults) would assert f(x)===f(x)
    // and pass even when that table names a segment no route matches.
    const prefixes =
      (routing.localePrefix as { prefixes?: Record<string, string> }).prefixes ?? {};
    process.env.ENABLED_CHECKOUT_LOCALES = routing.locales.join(',');
    for (const locale of routing.locales) {
      state.insertedOrders = [];
      state.session = { ...mockSession, locale };
      const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
      expect(res.status, `locale ${locale}`).toBe(200);
      const body = await res.json();
      const intent = JSON.parse(body.merchantData.paymentIntent) as { success_url: string };
      const segment =
        locale === routing.defaultLocale ? '' : (prefixes[locale] ?? `/${locale}`);
      expect(intent.success_url, `locale ${locale}`).toBe(
        `http://localhost${segment}/offer/details?sg_order=${encodeURIComponent(
          `${SESSION_ID}:trial1:1`,
        )}`,
      );
    }
  });

  it('requires a public forwarded IP in Vercel Production before creating an order', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SOLIDGATE_ENVIRONMENT = 'production';
    const res = await post({ productId: 'trial3', sessionId: SESSION_ID });
    expect(res.status).toBe(400);
    expect(state.insertedOrders).toHaveLength(0);
  });

  it('uses the forwarded public IP in Vercel Production', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.SOLIDGATE_ENVIRONMENT = 'production';
    const res = await post(
      { productId: 'trial3', sessionId: SESSION_ID },
      { 'x-forwarded-for': '185.179.185.6, 10.0.0.1' },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const intent = JSON.parse(body.merchantData.paymentIntent) as Record<string, unknown>;
    expect(intent.ip_address).toBe('185.179.185.6');
  });

  it('rejects a disabled locale before silently changing the quoted currency', async () => {
    state.session = { ...mockSession, locale: 'ja' };
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'checkout_locale_disabled' });
    expect(state.insertedOrders).toHaveLength(0);
  });

  it('increments the attempt so a retry never reuses a burnt order_id', async () => {
    seedOrder({ status: 'failed', solidgate_payment_status: 'declined' });
    seedOrder({
      status: 'failed',
      solidgate_payment_status: 'void_ok',
      solidgate_order_id: `${SESSION_ID}:trial1:2`,
    });
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect((await res.json()).orderId).toBe(`${SESSION_ID}:trial1:3`);
  });

  it('does not collision-bump when atomic allocation reports a duplicate', async () => {
    state.openRpcError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    };
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(0);
    expect(state.rpcCalls.filter((call) => call.name === 'open_solidgate_main_checkout_v2')).toHaveLength(1);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('still fails closed on a non-duplicate atomic open error', async () => {
    state.openRpcError = { code: '57014', message: 'statement timeout' };
    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });
    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(0);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('serializes two concurrent opens into one order and one form payload build', async () => {
    installOpenBarrier();

    const [first, second] = await Promise.all([
      post({ productId: 'trial1', sessionId: SESSION_ID }),
      post({ productId: 'trial1', sessionId: SESSION_ID }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(state.insertedOrders).toHaveLength(1);
    expect(buildFormMerchantDataMock).toHaveBeenCalledTimes(1);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.orderId).toBe(`${SESSION_ID}:trial1:1`);
    expect(secondBody.orderId).toBe(firstBody.orderId);
    expect(secondBody.merchantData).toEqual(firstBody.merchantData);
  });

  it('reuses a safely bound open order and its existing form payload', async () => {
    const order = seedOrder();
    const cachedMerchantData = {
      merchant: 'api_pk_test',
      paymentIntent: 'cached-payment-intent',
      signature: 'cached-signature',
    };
    state.checkoutState = {
      orderDbId: order.id,
      offerSlug: 'trial1',
      builderToken: mockOrderId(999),
      merchantData: cachedMerchantData,
    };

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      orderId: `${SESSION_ID}:trial1:1`,
      merchantData: cachedMerchantData,
    });
    expect(state.insertedOrders).toHaveLength(1);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('resumes a pre-migration open order without minting a replacement', async () => {
    seedOrder();

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect((await res.json()).orderId).toBe(`${SESSION_ID}:trial1:1`);
    expect(state.insertedOrders).toHaveLength(1);
    expect(buildFormMerchantDataMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['declined', 'declined'],
    ['voided', 'void_ok'],
  ])('a terminal %s order permits exactly one concurrent next attempt', async (_label, paymentStatus) => {
    seedOrder({
      status: 'failed',
      solidgate_payment_status: paymentStatus,
      ...(paymentStatus === 'void_ok' && {
        amount_cents: 0,
        solidgate_original_amount_cents: 500,
      }),
    });
    installOpenBarrier();

    const [first, second] = await Promise.all([
      post({ productId: 'trial1', sessionId: SESSION_ID }),
      post({ productId: 'trial1', sessionId: SESSION_ID }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(state.insertedOrders).toHaveLength(2);
    expect(state.insertedOrders.filter((order) => order.status === 'pending')).toHaveLength(1);
    expect((await first.json()).orderId).toBe(`${SESSION_ID}:trial1:2`);
    expect((await second.json()).orderId).toBe(`${SESSION_ID}:trial1:2`);
    expect(buildFormMerchantDataMock).toHaveBeenCalledTimes(1);
  });

  it('does not advance a locally failed order without terminal provider evidence', async () => {
    seedOrder({ status: 'failed', solidgate_payment_status: null });

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(1);
    expect(state.insertedOrders[0].solidgate_order_id).toBe(`${SESSION_ID}:trial1:1`);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it.each([
    ['product', { bound_product_slug: 'BRANDADDON_000000_SUB' }],
    ['amount', { bound_amount_cents: 501 }],
    ['currency', { bound_currency: 'usd' }],
    ['environment', { bound_payment_environment: 'production' }],
    ['order id', { solidgate_order_id: `${SESSION_ID}:trial2:99` }],
  ])('rejects an RPC %s binding mismatch before form creation', async (_label, override) => {
    state.reservationOverrides = override;

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(500);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('fails closed on a session read error before any checkout RPC or form creation', async () => {
    state.sessionError = { message: 'read unavailable' };

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(500);
    expect(state.rpcCalls).toHaveLength(0);
    expect(buildFormMerchantDataMock).not.toHaveBeenCalled();
  });

  it('fails closed when checkout payload finalization cannot be persisted', async () => {
    state.finalizeRpcError = { code: '57014', message: 'write unavailable' };

    const res = await post({ productId: 'trial1', sessionId: SESSION_ID });

    expect(res.status).toBe(503);
    expect(state.insertedOrders).toHaveLength(1);
    expect(buildFormMerchantDataMock).toHaveBeenCalledTimes(1);
    expect((await res.json()).merchantData).toBeUndefined();
  });
});
