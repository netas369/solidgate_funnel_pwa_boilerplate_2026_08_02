import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type RpcArgs = Record<string, unknown>;
type OpenOverrides = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  buildFormMerchantData: vi.fn(),
  getAccountVault: vi.fn(),
  chargeSavedCard: vi.fn(),
  subscribeSavedCard: vi.fn(),
  providerStatus: vi.fn(),
  rpc: vi.fn(),
  prefsLocale: "lt" as string | null,
  acquisition: {
    utm_source: "fb",
    utm_medium: "Facebook_Mobile_Feed",
    utm_campaign: "Creative Testing",
    utm_content: "Creative 7",
    utm_term: "Broad",
  } as Record<string, string> | null,
  owned: null as { id: string } | null,
  billable: null as { id: string } | null,
  billableError: null as { message: string } | null,
  ownershipFilters: [] as string[],
  ownedError: null as { message: string } | null,
  identityRows: [] as Array<{
    offer_slug: string;
    customer_email: string;
    checkout_locale: string;
    amount_cents: number;
    currency: string;
    tracking_metadata: Record<string, unknown>;
    purchase_mode: "hosted_form" | "saved_card";
    solidgate_product_id: string | null;
    solidgate_payment_action: "auth_settle";
  }>,
  openOverrides: {} as OpenOverrides,
  from: vi.fn(),
}));

function query(result: Record<string, unknown>) {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then(onfulfilled, onrejected) {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  (chain.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  (chain.eq as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  (chain.is as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  for (const method of ["or", "not", "in", "limit"]) chain[method] = vi.fn(() => chain);
  return chain;
}

// The shipped catalog-ids.json is intentionally SCRUBBED (all empty strings) —
// real ids are seeded per merchant by scripts/solidgate-seed-catalog.ts. These
// tests exercise the subscription branch, which is fail-closed on a missing
// provider product id, so they need a seeded catalog of their own.
vi.mock("@repo/shared/solidgate/catalog-ids.json", () => ({
  default: {
    addon_direct: {
      product_id: "product_uuid",
      prices: { eur: "price_uuid_eur", usd: "price_uuid_usd" },
    },
  },
}));

vi.mock("@repo/shared/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: vi.fn(() => ({ from: mocks.from, rpc: mocks.rpc })),
}));

vi.mock("@repo/shared/solidgate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/shared/solidgate")>();
  return {
    ...actual,
    SolidgateClient: class {
      status = mocks.providerStatus;
    },
    getSolidgateKeys: vi.fn(() => ({ publicKey: "public", secretKey: "secret" })),
    buildFormMerchantData: mocks.buildFormMerchantData,
    chargeSavedCard: mocks.chargeSavedCard,
    subscribeSavedCard: mocks.subscribeSavedCard,
  };
});

vi.mock("@repo/shared/solidgate/account-vault", () => ({
  getAccountVault: async (...args: unknown[]) => {
    const value = await mocks.getAccountVault(...args);
    // Existing fixtures predate token provenance and all model the pre-wallet
    // saved-card path. Individual wallet tests override this explicitly.
    return value && value.cardOriginalPaymentMethod === undefined
      ? { ...value, cardOriginalPaymentMethod: "card" }
      : value;
  },
}));

import { POST } from "./route";

const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;
const ORIGINAL_PWA_URL = process.env.NEXT_PUBLIC_PWA_URL;
const user = { id: "11111111-1111-4111-8111-111111111111", email: "buyer@example.com" };
const orderDbId = "22222222-2222-4222-8222-222222222222";
const merchantData = {
  merchant: "public",
  paymentIntent: "encrypted-intent",
  signature: "signed-intent",
};

function request(body: object, headers?: HeadersInit) {
  return new Request("https://app.example.com/api/solidgate/purchase", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function orderIdFor(args: RpcArgs, attempt = 1) {
  return `u-${String(args.p_user_id)}:${String(args.p_offer_slug)}:${attempt}`;
}

function opened(args: RpcArgs, overrides: OpenOverrides = {}) {
  const mode = String(args.p_requested_mode);
  const ownerClaim = overrides.claim_token === "__claim__"
    ? args.p_claim_token
    : overrides.claim_token;
  return {
    order_db_id: orderDbId,
    solidgate_order_id: orderIdFor(args),
    bound_payment_environment: args.p_payment_environment,
    bound_user_id: args.p_user_id,
    bound_offer_slug: args.p_offer_slug,
    bound_product_slug: args.p_product_slug,
    bound_product_name: args.p_product_slug,
    bound_amount_cents: args.p_amount_cents,
    bound_currency: args.p_currency,
    bound_order_status: "pending",
    bound_payment_status: "creating",
    bound_tracking_metadata: args.p_tracking_metadata,
    bound_customer_email: args.p_customer_email,
    bound_checkout_locale: args.p_checkout_locale,
    bound_solidgate_product_id: args.p_solidgate_product_id,
    bound_solidgate_payment_action: args.p_solidgate_payment_action,
    purchase_mode: mode,
    solidgate_subscription_id: null,
    verify_url: null,
    last_result_kind: null,
    last_result_net_amount_cents: null,
    is_new: true,
    should_build: mode === "hosted_form",
    should_submit: mode === "saved_card",
    needs_reconcile: false,
    claim_token: ownerClaim ?? args.p_claim_token,
    merchant_data: null,
    ...overrides,
    ...(overrides.claim_token === "__claim__" ? { claim_token: args.p_claim_token } : {}),
  };
}

function providerOrder(params: {
  orderId: string;
  amount: number;
  currency: string;
  status?: string;
  productId?: string;
  subscriptionId?: string | null;
  settledAmount?: number | null;
  customerAccountId?: string;
}) {
  return {
    order_id: params.orderId,
    customer_account_id: params.customerAccountId ?? "solidgate-customer-1",
    status: params.status ?? "processing",
    amount: params.amount,
    settled_amount: params.settledAmount,
    currency: params.currency.toUpperCase(),
    product_id: params.productId,
    subscription_id: params.subscriptionId,
  };
}

describe("Solidgate PWA purchase authority and idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_ENV = "preview";
    if (ORIGINAL_PWA_URL === undefined) delete process.env.NEXT_PUBLIC_PWA_URL;
    else process.env.NEXT_PUBLIC_PWA_URL = ORIGINAL_PWA_URL;
    mocks.prefsLocale = "lt";
    mocks.acquisition = {
      utm_source: "fb",
      utm_medium: "Facebook_Mobile_Feed",
      utm_campaign: "Creative Testing",
      utm_content: "Creative 7",
      utm_term: "Broad",
    };
    mocks.owned = null;
    mocks.ownedError = null;
    mocks.billable = null;
    mocks.billableError = null;
    mocks.ownershipFilters = [];
    mocks.identityRows = [];
    mocks.openOverrides = {};
    mocks.getUser.mockResolvedValue({ data: { user } });
    mocks.getAccountVault.mockResolvedValue(null);
    mocks.providerStatus.mockResolvedValue({});
    mocks.buildFormMerchantData.mockResolvedValue(merchantData);
    mocks.chargeSavedCard.mockImplementation(async (_client, params) => ({
      status: "success",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: params.amount,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "settle_ok",
      subscriptionId: null,
    }));
    mocks.subscribeSavedCard.mockImplementation(async (_client, params) => ({
      status: "success",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.expectedAmount,
      settledAmount: params.expectedAmount,
      amount: params.expectedAmount,
      currency: params.currency,
      productId: params.productId,
      providerStatus: "settle_ok",
      subscriptionId: "sub-addon-1",
    }));
    mocks.from.mockImplementation((table: string) => {
      if (table === "user_prefs") {
        return query({ data: { locale: mocks.prefsLocale }, error: null });
      }
      if (table === "user_acquisition_attribution") {
        return query({ data: mocks.acquisition, error: null });
      }
      if (table === "entitlements") {
        const chain = query({ data: mocks.owned, error: mocks.ownedError });
        chain.or = vi.fn((filter: string) => { mocks.ownershipFilters.push(filter); return chain; });
        return chain;
      }
      if (table === "orders") return query({ data: mocks.billable, error: mocks.billableError });
      throw new Error(`Unexpected table: ${table}`);
    });
    mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
      if (name === "apply_solidgate_financial_event") return { data: { net_amount_cents: 1200 }, error: null };
      if (name === "get_solidgate_pwa_checkout_identity") {
        return { data: mocks.identityRows, error: null };
      }
      if (name === "open_solidgate_pwa_purchase_v2") {
        return { data: [opened(args, mocks.openOverrides)], error: null };
      }
      if (name === "finalize_solidgate_pwa_form_v2") {
        return { data: args.p_merchant_data, error: null };
      }
      if (name === "resume_solidgate_pwa_submission_after_absent_reconcile") {
        return { data: true, error: null };
      }
      if (name === "record_solidgate_pwa_submission_result") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
  });

  afterAll(() => {
    if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
    if (ORIGINAL_PWA_URL === undefined) delete process.env.NEXT_PUBLIC_PWA_URL;
    else process.env.NEXT_PUBLIC_PWA_URL = ORIGINAL_PWA_URL;
  });

  it("prices from the stored profile locale, not the request body", async () => {
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { ...user, email: "  Buyer@Example.COM " } },
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all", locale: "hu", forceForm: true },
      { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    ));

    expect(response.status).toBe(200);
    expect(mocks.buildFormMerchantData).toHaveBeenCalledWith(
      "public",
      "secret",
      expect.objectContaining({
        currency: "EUR",
        language: "lt",
        apple_pay_merchant_name: "Acme",
        customer_email: "buyer@example.com",
        ip_address: "203.0.113.10",
        order_metadata: expect.objectContaining({
          funnel_code: "PWA",
          funnel_variant: "member_area",
          session_id: `u-${user.id}`,
          product_slug: "oto3_bundle_all",
          locale: "lt",
          utm_source: "fb",
          utm_campaign: "Creative Testing",
        }),
      }),
    );
    const intent = mocks.buildFormMerchantData.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(intent.order_metadata as object)).toHaveLength(10);
  });

  it("replays an exact pending order from its immutable email, locale, amount and metadata", async () => {
    const boundMetadata = {
      funnel_code: "PWA",
      funnel_variant: "member_area",
      session_id: `u-${user.id}`,
      product_slug: "oto3_bundle_all",
      locale: "en",
      utm_source: "original",
    };
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { ...user, email: "changed@example.com" } },
    });
    mocks.prefsLocale = "lt";
    mocks.identityRows = [{
      offer_slug: "oto3_bundle_all",
      customer_email: "buyer@example.com",
      checkout_locale: "en",
      amount_cents: 1234,
      currency: "usd",
      tracking_metadata: boundMetadata,
      purchase_mode: "hosted_form",
      solidgate_product_id: null,
      solidgate_payment_action: "auth_settle",
    }];

    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalledWith("user_prefs");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "open_solidgate_pwa_purchase_v2",
      expect.objectContaining({
        p_amount_cents: 1234,
        p_currency: "usd",
        p_customer_email: "buyer@example.com",
        p_checkout_locale: "en",
        p_tracking_metadata: boundMetadata,
        p_requested_mode: "hosted_form",
        p_solidgate_product_id: null,
        p_solidgate_payment_action: "auth_settle",
      }),
    );
    expect(mocks.buildFormMerchantData).toHaveBeenCalledWith(
      "public",
      "secret",
      expect.objectContaining({
        amount: 1234,
        currency: "USD",
        customer_email: "buyer@example.com",
        language: "en",
        order_metadata: boundMetadata,
      }),
    );
  });

  it("gives the hosted form an exact-order 3DS success return without an iframe fail URL", async () => {
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(200);
    const intent = mocks.buildFormMerchantData.mock.calls[0][2] as Record<string, unknown>;
    expect(intent.success_url).toBe(
      `https://app.example.com/lt/dashboard?sg_confirm=${encodeURIComponent(`u-${user.id}:oto3_bundle_all:1`)}`,
    );
    expect(intent).not.toHaveProperty("fail_url");
  });

  it.each([undefined, null, "", "not-an-email", "buyer @example.com"])(
    "rejects an unbindable authenticated email %s before opening or contacting Solidgate",
    async (email) => {
      mocks.getUser.mockResolvedValueOnce({ data: { user: { ...user, email } } });

      const response = await POST(request(
        { slug: "oto3_bundle_all", forceForm: true },
        { "x-forwarded-for": "203.0.113.10" },
      ));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "A valid authenticated email is required for payment",
      });
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "open_solidgate_pwa_purchase_v2",
        expect.anything(),
      );
      expect(mocks.getAccountVault).not.toHaveBeenCalled();
      expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
      expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
      expect(mocks.subscribeSavedCard).not.toHaveBeenCalled();
      expect(mocks.providerStatus).not.toHaveBeenCalled();
    },
  );

  it("does not invent a public IP in production", async () => {
    process.env.VERCEL_ENV = "production";
    const response = await POST(request({ slug: "oto3_bundle_all", forceForm: true }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Client IP is unavailable" });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "open_solidgate_pwa_purchase_v2",
      expect.anything(),
    );
  });

  it("rejects an insecure production return origin before opening an order", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_PWA_URL = "http://app.example.com";
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "open_solidgate_pwa_purchase_v2",
      expect.anything(),
    );
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it.each([
    ["hosted form", true, null],
    ["saved card", false, { cardToken: "token", customerAccountId: "solidgate-customer-1" }],
  ] as const)(
    "rejects a production %s with no trusted return URL before atomic open or provider work",
    async (_mode, forceForm, vault) => {
      process.env.VERCEL_ENV = "production";
      delete process.env.NEXT_PUBLIC_PWA_URL;
      mocks.getAccountVault.mockResolvedValue(vault);

      const response = await POST(request(
        { slug: "oto3_bundle_all", ...(forceForm && { forceForm: true }) },
        { "x-forwarded-for": "203.0.113.10" },
      ));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Payment return URL is not configured",
      });
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "open_solidgate_pwa_purchase_v2",
        expect.anything(),
      );
      expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
      expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
      expect(mocks.subscribeSavedCard).not.toHaveBeenCalled();
    },
  );

  it("fails closed when entitlement ownership cannot be read", async () => {
    mocks.ownedError = { message: "database unavailable" };
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(500);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "open_solidgate_pwa_purchase_v2",
      expect.anything(),
    );
  });

  it("keeps add-on native price and canonical metadata aligned", async () => {
    const response = await POST(request(
      { slug: "oto2_addon_weekly", locale: "lt", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    const intent = mocks.buildFormMerchantData.mock.calls[0][2] as Record<string, unknown>;
    const metadata = intent.order_metadata as Record<string, string>;
    expect(Object.keys(metadata)).toHaveLength(10);
    expect(metadata).toMatchObject({
      funnel_code: "PWA",
      funnel_variant: "member_area",
      product_slug: "oto2_addon_weekly",
      price_id: intent.product_price_id,
      utm_source: "fb",
      utm_medium: "Facebook_Mobile_Feed",
      utm_campaign: "Creative Testing",
      utm_content: "Creative 7",
      utm_term: "Broad",
    });
  });

  it("keeps canonical metadata within the provider cap without acquisition data", async () => {
    mocks.acquisition = null;
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    const intent = mocks.buildFormMerchantData.mock.calls[0][2] as Record<string, unknown>;
    expect(intent.order_metadata).toEqual({
      funnel_code: "PWA",
      funnel_variant: "member_area",
      session_id: `u-${user.id}`,
      product_slug: "oto3_bundle_all",
      locale: "lt",
    });
  });

  it("uses the originally bound metadata when optional attribution later drifts", async () => {
    const boundMetadata = {
      funnel_code: "PWA",
      funnel_variant: "member_area",
      session_id: `u-${user.id}`,
      product_slug: "oto3_bundle_all",
      locale: "lt",
    };
    mocks.openOverrides = { bound_tracking_metadata: boundMetadata };
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.buildFormMerchantData).toHaveBeenCalledWith(
      "public",
      "secret",
      expect.objectContaining({ order_metadata: boundMetadata }),
    );
  });

  it("reuses cached hosted-form merchant data byte-for-byte", async () => {
    mocks.openOverrides = {
      is_new: false,
      should_build: false,
      claim_token: null,
      merchant_data: merchantData,
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      needsCard: true,
      merchantData,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "finalize_solidgate_pwa_form_v2",
      expect.anything(),
    );
  });

  it.each(["created", "processing", "auth_ok", "partial_settled"])(
    "does not re-expose a hosted form after provider status %s",
    async (providerStatus) => {
      mocks.openOverrides = {
        is_new: false,
        should_build: false,
        claim_token: null,
        bound_payment_status: providerStatus,
        merchant_data: merchantData,
      };
      const response = await POST(request(
        { slug: "oto3_bundle_all", forceForm: true },
        { "x-forwarded-for": "203.0.113.10" },
      ));
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        pending: true,
        accepted: false,
        orderId: `u-${user.id}:oto3_bundle_all:1`,
      });
      expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
    },
  );

  it("publishes one hosted form and returns the same cache on sequential replay", async () => {
    let cached: unknown = null;
    let firstClaim: unknown = null;
    mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
      if (name === "get_solidgate_pwa_checkout_identity") {
        return { data: mocks.identityRows, error: null };
      }
      if (name === "open_solidgate_pwa_purchase_v2") {
        firstClaim ??= args.p_claim_token;
        return {
          data: [opened(args, cached
            ? { is_new: false, should_build: false, claim_token: null, merchant_data: cached }
            : { claim_token: "__claim__" })],
          error: null,
        };
      }
      if (name === "finalize_solidgate_pwa_form_v2") {
        expect(args.p_claim_token).toBe(firstClaim);
        cached = args.p_merchant_data;
        return { data: cached, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const first = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    const second = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ merchantData, orderId: `u-${user.id}:oto3_bundle_all:1` });
    expect(mocks.buildFormMerchantData).toHaveBeenCalledTimes(1);
  });

  it("gives a saved-card charge a trusted Preview return URL and disables nested polling", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all", locale: "lt" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        customerAccountId: "solidgate-customer-1",
        paymentType: "1-click",
        successUrl: `https://app.example.com/lt/dashboard?sg_confirm=${encodeURIComponent(`u-${user.id}:oto3_bundle_all:1`)}`,
        settlement: { attempts: 0 },
      }),
    );
  });

  it.each(["apple-pay", "google-pay"])(
    "submits a saved %s credential as rebill",
    async (cardOriginalPaymentMethod) => {
      mocks.getAccountVault.mockResolvedValue({
        cardToken: "wallet-token",
        cardOriginalPaymentMethod,
        customerAccountId: "solidgate-customer-1",
      });

      const response = await POST(request(
        { slug: "oto3_bundle_all", locale: "lt" },
        { "x-forwarded-for": "203.0.113.10" },
      ));

      expect(response.status).toBe(200);
      expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recurringToken: "wallet-token",
          paymentType: "rebill",
        }),
      );
    },
  );

  it.each([null, "click-to-pay", "unknown"])(
    "uses a new hosted form instead of reusing unsupported origin %s",
    async (cardOriginalPaymentMethod) => {
      mocks.getAccountVault.mockResolvedValue({
        cardToken: "unsupported-token",
        cardOriginalPaymentMethod,
        customerAccountId: "solidgate-customer-1",
      });

      const response = await POST(request(
        { slug: "oto3_bundle_all", locale: "lt" },
        { "x-forwarded-for": "203.0.113.10" },
      ));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ needsCard: true, merchantData });
      expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["provider order", { providerOrderId: "some-other-order" }],
    ["customer account", { customerAccountId: "some-other-customer" }],
  ])("rejects a captured response bound to another %s", async (_label, identityOverride) => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "success",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: params.amount,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "settle_ok",
      subscriptionId: null,
      ...identityOverride,
    }));

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("accepts a processing order with verify_url as a valid saved-card challenge", async () => {
    const verifyUrl = "https://acs.example.test/challenge";
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "requires_action",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: null,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "processing",
      subscriptionId: null,
      verifyUrl,
    }));

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requiresAction: true,
      verifyUrl,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "requires_action",
        p_provider_status: "processing",
        p_verify_url: verifyUrl,
      }),
    );
  });

  it.each([
    ["cs", "/cz"],
    ["da", "/dk"],
    ["zh-TW", "/tw"],
    ["el", "/gr"],
    ["he", "/il"],
    ["ja", "/jp"],
    ["pl", "/pl"],
    ["en", ""],
  ])("returns a saved-card challenge for %s to %s/dashboard", async (locale, segment) => {
    mocks.prefsLocale = locale;
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all", locale },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        successUrl: `https://app.example.com${segment}/dashboard?sg_confirm=${encodeURIComponent(`u-${user.id}:oto3_bundle_all:1`)}`,
      }),
    );
  });

  it("uses the vault identity for a saved-card add-on subscription", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    const response = await POST(request(
      { slug: "oto2_addon_weekly", locale: "lt" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.subscribeSavedCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        customerAccountId: "solidgate-customer-1",
        paymentType: "1-click",
        expectedAmount: 1900,
        currency: "eur",
        settlement: { attempts: 0 },
      }),
    );
  });

  it("returns an active saved-card follower without a second provider call", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      claim_token: null,
      bound_payment_status: "creating",
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.providerStatus).not.toHaveBeenCalled();
  });

  it("returns a stored 3ds_verify challenge to a follower on the same order", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      claim_token: null,
      bound_payment_status: "3ds_verify",
      verify_url: "https://acs.example.test/challenge",
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requiresAction: true,
      verifyUrl: "https://acs.example.test/challenge",
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it.each(["created", "processing", "auth_ok"])(
    "ignores a stale stored ACS URL after the provider state advances to %s",
    async (providerStatus) => {
      mocks.getAccountVault.mockResolvedValue({
        cardToken: "token",
        customerAccountId: "solidgate-customer-1",
      });
      mocks.openOverrides = {
        is_new: false,
        should_submit: false,
        claim_token: null,
        bound_payment_status: providerStatus,
        verify_url: "https://acs.example.test/stale-challenge",
      };

      const response = await POST(request(
        { slug: "oto3_bundle_all" },
        { "x-forwarded-for": "203.0.113.10" },
      ));

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        pending: true,
        orderId: `u-${user.id}:oto3_bundle_all:1`,
      });
      expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    },
  );

  it("returns a captured-but-unfulfilled follower for confirmation without charging again", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      claim_token: null,
      bound_payment_status: "settle_ok",
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      confirmRequired: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("resumes confirmation for an exactly recorded full partial_settled capture", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      claim_token: null,
      bound_payment_status: "partial_settled",
      last_result_kind: "captured",
      last_result_net_amount_cents: 4900,
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      confirmRequired: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("does not infer a capture from partial_settled without stored exact-net proof", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      claim_token: null,
      bound_payment_status: "partial_settled",
    };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("serializes overlapping saved-card requests onto one provider submitter", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    let openCount = 0;
    let releaseCharge!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => {
      await chargeGate;
      return {
        status: "success",
        orderId: params.orderId,
        providerOrderId: params.orderId,
        customerAccountId: params.customerAccountId,
        orderAmount: params.amount,
        settledAmount: params.amount,
        amount: params.amount,
        currency: params.currency,
        providerStatus: "settle_ok",
        subscriptionId: null,
      };
    });
    mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
      if (name === "get_solidgate_pwa_checkout_identity") {
        return { data: mocks.identityRows, error: null };
      }
      if (name === "open_solidgate_pwa_purchase_v2") {
        openCount += 1;
        return {
          data: [opened(args, openCount === 1
            ? { claim_token: "__claim__" }
            : { is_new: false, should_submit: false, claim_token: null })],
          error: null,
        };
      }
      if (name === "record_solidgate_pwa_submission_result") return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const firstPromise = POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    await vi.waitFor(() => expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1));
    const follower = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(follower.status).toBe(202);
    releaseCharge();
    const owner = await firstPromise;
    expect(owner.status).toBe(200);
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    const submittedIds = mocks.chargeSavedCard.mock.calls.map((call) => call[1].orderId);
    expect(new Set(submittedIds)).toEqual(new Set([`u-${user.id}:oto3_bundle_all:1`]));
  });

  it("reconciles an expired lease and never resubmits an observed provider order", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "processing",
      }),
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    expect(mocks.providerStatus).toHaveBeenCalledWith({ order_id: `u-${user.id}:oto3_bundle_all:1` });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({ p_result_kind: "pending", p_provider_status: "processing" }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "resume_solidgate_pwa_submission_after_absent_reconcile",
      expect.anything(),
    );
  });

  it("clears a stale stored ACS URL when current reconciliation is processing without one", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
      verify_url: "https://acs.example.test/stale-challenge",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "processing",
      }),
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      pending: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "pending",
        p_provider_status: "processing",
        p_verify_url: null,
      }),
    );
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("recovers Solidgate Support's verify_link alias from a 3DS status response", async () => {
    const verifyUrl = "https://acs.example.test/recovered-wallet-challenge";
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "wallet-token",
      customerAccountId: "solidgate-customer-1",
      cardOriginalPaymentMethod: "apple-pay",
    });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "3ds_verify",
      }),
      verify_link: verifyUrl,
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requiresAction: true,
      verifyUrl,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "requires_action",
        p_provider_status: "3ds_verify",
        p_verify_url: verifyUrl,
      }),
    );
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("never falls back to a stored ACS URL when current provider aliases conflict", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "wallet-token",
      customerAccountId: "solidgate-customer-1",
      cardOriginalPaymentMethod: "apple-pay",
    });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
      verify_url: "https://acs.example.test/stored-challenge",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "3ds_verify",
      }),
      verify_url: "https://acs.example.test/canonical",
      verify_link: "https://acs.example.test/conflicting-alias",
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      pending: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
    });
    expect(body).not.toHaveProperty("verifyUrl");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "pending",
        p_provider_status: "3ds_verify",
        p_verify_url: null,
      }),
    );
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("resumes the same ID only after expired-owner status proves provider absence", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      error: { code: "2.01", messages: { order: ["Order not found."] } },
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "resume_solidgate_pwa_submission_after_absent_reconcile",
      expect.objectContaining({
        p_solidgate_order_id: `u-${user.id}:oto3_bundle_all:1`,
      }),
    );
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.chargeSavedCard.mock.calls[0][1].orderId).toBe(`u-${user.id}:oto3_bundle_all:1`);
  });

  it("does not treat a reconciliation transport error as provider absence", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockRejectedValue(new Error("timeout"));
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "resume_solidgate_pwa_submission_after_absent_reconcile",
      expect.anything(),
    );
  });

  it("does not treat a non-not-found provider error as proof of absence", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      error: { code: "1.01", messages: ["Authentication failed"] },
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "resume_solidgate_pwa_submission_after_absent_reconcile",
      expect.anything(),
    );
  });

  it("keeps a timed-out submit on the same order and reconciles it before retry", async () => {
    const canonicalOrderId = `u-${user.id}:oto3_bundle_all:1`;
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.chargeSavedCard.mockRejectedValueOnce(
      Object.assign(new Error("Solidgate request timed out after 15000ms"), { name: "AbortError" }),
    );
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: canonicalOrderId,
        amount: 4900,
        currency: "eur",
        status: "processing",
      }),
    });
    let openCount = 0;
    mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
      if (name === "get_solidgate_pwa_checkout_identity") {
        return { data: mocks.identityRows, error: null };
      }
      if (name === "open_solidgate_pwa_purchase_v2") {
        openCount += 1;
        return {
          data: [opened(args, openCount === 1
            ? { claim_token: "__claim__" }
            : {
                is_new: false,
                should_submit: false,
                needs_reconcile: true,
                claim_token: "__claim__",
              })],
          error: null,
        };
      }
      if (name === "record_solidgate_pwa_submission_result") return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const timedOut = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(timedOut.status).toBe(202);
    await expect(timedOut.json()).resolves.toMatchObject({
      accepted: false,
      pending: true,
      orderId: canonicalOrderId,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );

    const reconciled = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(reconciled.status).toBe(202);
    expect(mocks.providerStatus).toHaveBeenCalledWith({ order_id: canonicalOrderId });
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_solidgate_order_id: canonicalOrderId,
        p_result_kind: "pending",
        p_provider_status: "processing",
      }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "resume_solidgate_pwa_submission_after_absent_reconcile",
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("retires only an exact terminal provider result with net zero under the claim", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "failed",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: null,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "auth_failed",
      subscriptionId: null,
      errorCode: "3.01",
      errorMessage: "Declined",
    }));
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ needsNewCard: true, status: "auth_failed" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "terminal_failure",
        p_provider_status: "auth_failed",
        p_net_amount_cents: 0,
      }),
    );
  });

  it("does not retire a terminal response that reports a positive settlement", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "failed",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: 1,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "declined",
      subscriptionId: null,
    }));

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("does not retire a terminal response carrying conflicting challenge aliases", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "failed",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: null,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "auth_failed",
      subscriptionId: null,
      verifyUrlConflict: true,
    }));

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("does not retire an add-on decline that reports a subscription", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.subscribeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "failed",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.expectedAmount,
      settledAmount: null,
      amount: params.expectedAmount,
      currency: params.currency,
      productId: params.productId,
      providerStatus: "auth_failed",
      subscriptionId: "sub-contradictory",
    }));

    const response = await POST(request(
      { slug: "oto2_addon_weekly" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("does not retire a reconciled terminal order with a current challenge URL", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "void_ok",
      }),
      verify_url: "https://acs.example.test/still-actionable",
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("does not retire a reconciled terminal order with conflicting challenge aliases", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.openOverrides = {
      is_new: false,
      should_submit: false,
      needs_reconcile: true,
      claim_token: "__claim__",
    };
    mocks.providerStatus.mockResolvedValue({
      order: providerOrder({
        orderId: `u-${user.id}:oto3_bundle_all:1`,
        amount: 4900,
        currency: "eur",
        status: "void_ok",
      }),
      verify_url: "https://acs.example.test/canonical",
      verify_link: "https://acs.example.test/conflicting-alias",
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(502);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("fails closed when interpretation reports requires_action for a terminal provider status", async () => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => ({
      status: "requires_action",
      orderId: params.orderId,
      providerOrderId: params.orderId,
      customerAccountId: params.customerAccountId,
      orderAmount: params.amount,
      settledAmount: null,
      amount: params.amount,
      currency: params.currency,
      providerStatus: "auth_failed",
      subscriptionId: null,
      verifyUrl: "https://acs.example.test/stale-terminal-challenge",
    }));

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Provider returned an invalid payment challenge",
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.anything(),
    );
  });

  it("retires a definite provider rejection without an order and requests a fresh card", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.chargeSavedCard.mockResolvedValueOnce({
      status: "failed",
      orderId: `u-${user.id}:oto3_bundle_all:1`,
      providerStatus: "request_rejected",
      errorCode: "2.01",
      errorMessage: "Invalid request",
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      needsNewCard: true,
      orderId: `u-${user.id}:oto3_bundle_all:1`,
      status: "request_rejected",
      code: "2.01",
      error: "Invalid request",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({
        p_result_kind: "terminal_failure",
        p_provider_status: "request_rejected",
        p_net_amount_cents: 0,
        p_subscription_id: null,
        p_verify_url: null,
      }),
    );
  });

  it.each([
    ["provider order id", { providerOrderId: `u-${user.id}:oto3_bundle_all:1` }],
    ["customer account", { customerAccountId: "solidgate-customer-1" }],
    ["amount", { amount: 4900 }],
    ["order amount", { orderAmount: 4900 }],
    ["settled amount", { settledAmount: 0 }],
    ["currency", { currency: "usd" }],
    ["product", { productId: "provider-product" }],
    ["subscription", { subscriptionId: null }],
    ["challenge URL", { verifyUrl: "https://acs.example.test/contradiction" }],
  ] as const)("fails closed when a rejected request also carries %s evidence", async (_label, evidence) => {
    mocks.getAccountVault.mockResolvedValue({
      cardToken: "token",
      customerAccountId: "solidgate-customer-1",
    });
    mocks.chargeSavedCard.mockResolvedValueOnce({
      status: "failed",
      orderId: `u-${user.id}:oto3_bundle_all:1`,
      providerStatus: "request_rejected",
      errorCode: "2.01",
      errorMessage: "Invalid request",
      ...evidence,
    });

    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Provider returned contradictory rejected-request evidence",
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "record_solidgate_pwa_submission_result",
      expect.objectContaining({ p_result_kind: "terminal_failure" }),
    );
  });

  it("does not expose a stale owner's success after the claim fence is lost", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.rpc.mockImplementation(async (name: string, args: RpcArgs) => {
      if (name === "get_solidgate_pwa_checkout_identity") {
        return { data: mocks.identityRows, error: null };
      }
      if (name === "open_solidgate_pwa_purchase_v2") return { data: [opened(args)], error: null };
      if (name === "record_solidgate_pwa_submission_result") return { data: false, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ pending: true });
  });

  it("fails closed on an RPC binding mismatch", async () => {
    mocks.openOverrides = { bound_amount_cents: 1 };
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(500);
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
  });

  it("fails closed when an owner action is paired with provider-visible state", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    mocks.openOverrides = { bound_payment_status: "processing" };
    const response = await POST(request(
      { slug: "oto3_bundle_all" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(500);
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.providerStatus).not.toHaveBeenCalled();
  });

  it("fails closed when an existing attempt is pinned to another submission mode", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "PWA purchase mode mismatch" },
    });
    const response = await POST(request(
      { slug: "oto3_bundle_all", forceForm: true },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    expect(response.status).toBe(503);
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });
  it('requires active unexpired ownership instead of treating a past-due add-on as owned', async () => {
    mocks.billable = { id: 'prior-billable-subscription' };
    const response = await POST(request({ slug: 'oto2_addon_weekly' }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ recoveryRequired: true, recoveryPath: '/billing/update-payment' });
    expect(mocks.ownershipFilters).toContain('status.eq.active,and(status.eq.past_due,access_level.eq.grace)');
    expect(mocks.ownershipFilters.some((filter) => filter.startsWith('expires_at.is.null,expires_at.gt.'))).toBe(true);
    expect(mocks.subscribeSavedCard).not.toHaveBeenCalled();
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('open_solidgate_pwa_purchase_v2', expect.anything());
  });

  it('fails closed if existing billable subscriptions cannot be read', async () => {
    mocks.billableError = { message: 'database unavailable' };
    const response = await POST(request({ slug: 'oto2_addon_weekly' }));
    expect(response.status).toBe(503);
    expect(mocks.subscribeSavedCard).not.toHaveBeenCalled();
  });

  it("persists an under-capture and polls the same order until the original quote is fully paid", async () => {
    mocks.getAccountVault.mockResolvedValue({ cardToken: "token", customerAccountId: "solidgate-customer-1" });
    let originalQuote = 0;
    mocks.chargeSavedCard.mockImplementationOnce(async (_client, params) => {
      originalQuote = params.amount;
      return {
        status: "pending", orderId: params.orderId, providerOrderId: params.orderId,
        customerAccountId: params.customerAccountId, orderAmount: params.amount,
        settledAmount: 1200, currency: params.currency, providerStatus: "partial_settled",
      };
    });
    const first = await POST(request({ slug: "oto3_bundle_all" }));
    expect(first.status).toBe(202);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_solidgate_financial_event", expect.objectContaining({
      p_facts: expect.objectContaining({
        order_db_id: orderDbId, captured_amount_cents: 1200, quoted_amount_cents: originalQuote,
      }),
    }));
    const rpcNames = mocks.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames.indexOf("record_solidgate_pwa_submission_result")).toBeLessThan(
      rpcNames.indexOf("apply_solidgate_financial_event"),
    );
    mocks.openOverrides = {
      is_new: false, should_submit: false, claim_token: null,
      bound_payment_status: "partial_settled", last_result_kind: "pending",
      last_result_net_amount_cents: originalQuote,
    };
    const existingOrderId = `u-${user.id}:oto3_bundle_all:1`;
    mocks.providerStatus.mockResolvedValue({ order: providerOrder({
      orderId: existingOrderId, amount: originalQuote, currency: "eur",
      status: "settle_ok", settledAmount: originalQuote,
    }) });
    const next = await POST(request({ slug: "oto3_bundle_all" }));
    expect(next.status).toBe(200);
    await expect(next.json()).resolves.toMatchObject({ confirmRequired: true, orderId: existingOrderId });
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.providerStatus).toHaveBeenCalledTimes(1);
  });


});
