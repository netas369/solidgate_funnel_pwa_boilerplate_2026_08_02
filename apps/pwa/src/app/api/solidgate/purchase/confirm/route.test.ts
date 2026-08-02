import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  status: vi.fn(),
  from: vi.fn(),
  ordersMaybeSingle: vi.fn(),
  entitlementsMaybeSingle: vi.fn(),
  pwaStateMaybeSingle: vi.fn(),
  update: vi.fn(),
  rpc: vi.fn(),
  after: vi.fn(),
  drainTokenSync: vi.fn(),
  upsertAccountVault: vi.fn(),
  upsertEntitlement: vi.fn(),
  filterCalls: [] as Array<[string, unknown]>,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});

function ordersQuery() {
  const chain: Record<string, unknown> & PromiseLike<unknown> = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    update: mocks.update,
    maybeSingle: mocks.ordersMaybeSingle,
    then(onfulfilled, onrejected) {
      return Promise.resolve({ error: null }).then(onfulfilled, onrejected);
    },
  };
  (chain.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  (chain.eq as ReturnType<typeof vi.fn>).mockImplementation((column: string, value: unknown) => {
    mocks.filterCalls.push([column, value]);
    return chain;
  });
  (chain.is as ReturnType<typeof vi.fn>).mockImplementation((column: string, value: unknown) => {
    mocks.filterCalls.push([column, value]);
    return chain;
  });
  (chain.in as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  mocks.update.mockReturnValue(chain);
  return chain;
}

function entitlementsQuery() {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.entitlementsMaybeSingle,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

function pwaStateQuery() {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.pwaStateMaybeSingle,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

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
    SolidgateClient: class { status = mocks.status; },
    getSolidgateKeys: vi.fn(() => ({ publicKey: "public", secretKey: "secret" })),
  };
});

vi.mock("@repo/shared/solidgate/account-vault", () => ({
  upsertAccountVault: mocks.upsertAccountVault,
}));

vi.mock("@repo/shared/entitlements", () => ({
  upsertEntitlement: mocks.upsertEntitlement,
}));

vi.mock("@repo/shared/solidgate/subscription-token-sync", () => ({
  drainSolidgateSubscriptionTokenSync: mocks.drainTokenSync,
}));

import { POST } from "./route";

const user = { id: "11111111-1111-1111-1111-111111111111" };
const orderId = `u-${user.id}:oto3_bundle_all:1`;
const order = {
  id: "db-order",
  user_id: user.id,
  session_id: null,
  psp: "solidgate",
  product_name: "BRANDBUNDLE_000000_PDF",
  product_slug: "BRANDBUNDLE_000000_PDF",
  amount_cents: 3000,
  currency: "eur",
  status: "pending",
  tracking_metadata: {
    funnel_code: "PWA",
    funnel_variant: "member_area",
    session_id: `u-${user.id}`,
    product_slug: "oto3_bundle_all",
    locale: "lt",
  },
  solidgate_payment_status: null,
  solidgate_original_amount_cents: 3000,
  solidgate_refunded_amount_cents: 0,
  solidgate_chargeback_id: null,
  solidgate_chargeback_status: null,
  solidgate_chargeback_amount_cents: 0,
  solidgate_customer_email: "buyer@example.com",
  solidgate_checkout_locale: "lt",
  solidgate_product_id: null,
  solidgate_payment_action: "auth_settle",
  solidgate_checkout_identity_legacy: false,
};

function settleTransaction(id: string, amount: number) {
  return {
    id,
    created_at: "2026-07-16 08:50:00",
    updated_at: "2026-07-16 08:50:01",
    amount,
    currency: "EUR",
    operation: "settle",
    status: "success",
    card: {
      bin: "411111",
      brand: "VISA",
      card_exp_month: "12",
      card_exp_year: 2028,
      number: "411111XXXXXX4242",
    },
  };
}

function tokenAuthorization(id = "tx-token", overrides: Record<string, unknown> = {}) {
  return {
    ...settleTransaction(id, 3000),
    operation: "auth",
    card_token: { token: "tok-new-card", original_payment_method: "card" },
    ...overrides,
  };
}

function request(requestOrderId = orderId) {
  return new Request("https://app.example.com/api/solidgate/purchase/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: requestOrderId }),
  });
}

function expectNoPurchaseMutation() {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
  expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
}

describe("PWA Solidgate confirmation binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.filterCalls.length = 0;
    mocks.getUser.mockResolvedValue({ data: { user } });
    mocks.from.mockImplementation((table: string) => {
      if (table === "orders") return ordersQuery();
      if (table === "entitlements") return entitlementsQuery();
      if (table === "solidgate_pwa_purchase_states") return pwaStateQuery();
      throw new Error(`Unexpected table: ${table}`);
    });
    mocks.ordersMaybeSingle.mockResolvedValue({ data: order, error: null });
    mocks.entitlementsMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.pwaStateMaybeSingle.mockResolvedValue({
      data: { purchase_mode: "hosted_form" },
      error: null,
    });
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "record_solidgate_pwa_confirmed_capture") {
        return { data: "hosted_form", error: null };
      }
      if (name === "grant_solidgate_pwa_entitlement") {
        mocks.upsertEntitlement({
          userId: args.p_user_id,
          productSlug: args.p_product_slug,
          accessLevel: args.p_access_level,
          expiresAt: args.p_expires_at,
          solidgateSubscriptionId: args.p_solidgate_subscription_id,
          orderId: args.p_order_db_id,
          source: args.p_source,
        });
        return { data: true, error: null };
      }
      if (name === "write_solidgate_account_vault_with_method") {
        mocks.upsertAccountVault({}, {
          userId: args.p_user_id,
          card: {
            token: args.p_card_token,
            brand: args.p_card_brand,
            maskedNumber: "411111XXXXXX4242",
          },
        });
        return { data: "written", error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms a valid bound PWA purchase and returns canonical commerce data", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        product_name: "Provider catalog label",
      },
      transactions: {
        tx1: {
          id: "tx1",
          created_at: "2026-07-16 08:50:00",
          updated_at: "2026-07-16 08:50:01",
          amount: 3000,
          currency: "EUR",
          operation: "auth",
          status: "success",
          card_token: { token: "tok-new-card", original_payment_method: "card" },
          card: {
            bin: "411111",
            brand: "VISA",
            card_exp_month: "12",
            card_exp_year: 2028,
            number: "411111XXXXXX4242",
          },
        },
      },
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      subscriptionId: null,
      payment: {
        event_name: "purchase_completed",
        order_id: orderId,
        transaction_id: orderId,
        product_id: "BRANDBUNDLE_000000_PDF",
        product_code: "BRANDBUNDLE_000000_PDF",
        product_name: "Bundle (all)",
        product_slug: "oto3_bundle_all",
        amount_cents: 3000,
        currency: "EUR",
        billing_type: "one_time",
        provider: "solidgate",
        source: "pwa",
      },
    });
    expect(mocks.upsertAccountVault).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: user.id,
        card: {
          token: "tok-new-card",
          brand: "VISA",
          maskedNumber: "411111XXXXXX4242",
        },
      },
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        solidgate_subscription_id: null,
        solidgate_verify_url: null,
        solidgate_submission_token: null,
        solidgate_submission_started_at: null,
      }),
    );
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        productSlug: "BRANDBUNDLE_000000_PDF",
        accessLevel: "full",
        expiresAt: null,
        source: "solidgate_pwa",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_solidgate_pwa_confirmed_capture",
      {
        p_payment_environment: "sandbox",
        p_user_id: user.id,
        p_offer_slug: "oto3_bundle_all",
        p_product_slug: "BRANDBUNDLE_000000_PDF",
        p_order_db_id: order.id,
        p_solidgate_order_id: orderId,
        p_amount_cents: 3000,
        p_currency: "eur",
        p_provider_status: "settle_ok",
        p_subscription_id: null,
      },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      {
        p_payment_environment: "sandbox",
        p_user_id: user.id,
        p_source_kind: "pwa_order",
        p_source_id: order.id,
        p_source_claim_token: null,
        p_card_token: "tok-new-card",
        p_card_brand: "VISA",
        p_card_last4: "4242",
        p_original_payment_method: "card",
      },
    );
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it("uses signed order payment_method when Payment Form omits token provenance", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        payment_method: "card",
        customer_account_id: user.id,
      },
      transaction: tokenAuthorization("tx-token", {
        card_token: {
          token: "tok-new-card",
          original_payment_method: undefined,
        },
      }),
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({
        p_card_token: "tok-new-card",
        p_original_payment_method: "card",
      }),
    );
  });

  it.each([
    [
      "Apple Pay",
      tokenAuthorization("tx-apple-pay", {
        operation: "apple-pay",
        card_token: {
          token: "tok-apple-pay",
          original_payment_method: "apple-pay",
        },
      }),
      "tok-apple-pay",
      "apple-pay",
    ],
    [
      "Google Pay with nested token metadata",
      tokenAuthorization("tx-google-pay", {
        operation: "google-pay",
        card_token: undefined,
        card: {
          ...settleTransaction("tx-google-pay", 3000).card,
          card_token: {
            token: "tok-google-pay",
            original_payment_method: "google-pay",
          },
        },
      }),
      "tok-google-pay",
      "google-pay",
    ],
  ])(
    "vaults an aligned hosted-form %s token with its provenance",
    async (_case, transaction, expectedToken, expectedMethod) => {
      mocks.status.mockResolvedValue({
        order: {
          order_id: orderId,
          status: "settle_ok",
          amount: 3000,
          currency: "EUR",
          refunded_amount: 0,
          customer_account_id: user.id,
        },
        transaction,
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
      expect(mocks.rpc).toHaveBeenCalledWith(
        "write_solidgate_account_vault_with_method",
        expect.objectContaining({
          p_card_token: expectedToken,
          p_original_payment_method: expectedMethod,
        }),
      );
    },
  );

  it.each(["saved_card", "stale"] as const)(
    "grants an exact %s capture without replacing the account vault",
    async (captureMode) => {
      mocks.status.mockResolvedValue({
        order: {
          order_id: orderId,
          status: "settle_ok",
          amount: 3000,
          currency: "EUR",
          refunded_amount: 0,
          customer_account_id: user.id,
          product_name: "Provider catalog label",
        },
        transaction: tokenAuthorization(),
      });
      mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === "record_solidgate_pwa_confirmed_capture") {
          return { data: captureMode, error: null };
        }
        if (name === "grant_solidgate_pwa_entitlement") {
          mocks.upsertEntitlement({
            userId: args.p_user_id,
            productSlug: args.p_product_slug,
            orderId: args.p_order_db_id,
          });
          return { data: true, error: null };
        }
        throw new Error(`Unexpected rpc for ${captureMode}: ${name}`);
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
      expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
      expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "write_solidgate_account_vault_with_method",
        expect.anything(),
      );
    },
  );

  it.each([
    [
      "a mapped transaction whose key differs from its id",
      { transactions: { unexpected: tokenAuthorization("tx-token") } },
    ],
    [
      "contradictory direct and nested tokens",
      {
        transaction: tokenAuthorization("tx-token", {
          card: {
            ...settleTransaction("tx-token", 3000).card,
            card_token: { token: "different-token" },
          },
        }),
      },
    ],
    [
      "a token without original payment method",
      {
        transaction: tokenAuthorization("tx-token", {
          card_token: { token: "tok-new-card" },
        }),
      },
    ],
    [
      "contradictory direct and nested original payment methods",
      {
        transaction: tokenAuthorization("tx-token", {
          card: {
            ...settleTransaction("tx-token", 3000).card,
            card_token: {
              token: "tok-new-card",
              original_payment_method: "google-pay",
            },
          },
        }),
      },
    ],
    [
      "an operation and original payment method mismatch",
      {
        transaction: tokenAuthorization("tx-token", {
          operation: "apple-pay",
        }),
      },
    ],
    [
      "an unsupported click-to-pay token",
      {
        transaction: tokenAuthorization("tx-token", {
          card_token: {
            token: "tok-new-card",
            original_payment_method: "click-to-pay",
          },
        }),
      },
    ],
    [
      "contradictory duplicate transaction card data",
      {
        transaction: tokenAuthorization("tx-token"),
        transactions: {
          "tx-token": tokenAuthorization("tx-token", {
            card: {
              ...settleTransaction("tx-token", 3000).card,
              brand: "MASTERCARD",
            },
          }),
        },
      },
    ],
    [
      "a successful settlement transaction",
      { transaction: tokenAuthorization("tx-token", { operation: "settle" }) },
    ],
    [
      "an authorization for a different amount",
      { transaction: tokenAuthorization("tx-token", { amount: 2999 }) },
    ],
    [
      "an authorization in a different currency",
      { transaction: tokenAuthorization("tx-token", { currency: "USD" }) },
    ],
    [
      "multiple distinct successful authorization tokens",
      {
        transactions: {
          "tx-token-1": tokenAuthorization("tx-token-1"),
          "tx-token-2": tokenAuthorization("tx-token-2", {
            card_token: {
              token: "second-token",
              original_payment_method: "card",
            },
          }),
        },
      },
    ],
  ])("grants a captured purchase and watermarks %s without a token", async (_case, transactionShape) => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      ...transactionShape,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({
        p_source_kind: "pwa_order",
        p_source_id: order.id,
        p_card_token: null,
        p_card_brand: null,
        p_card_last4: null,
        p_original_payment_method: null,
      }),
    );
  });

  it("grants access but returns retryable failure when the hosted watermark write fails", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "record_solidgate_pwa_confirmed_capture") {
        return { data: "hosted_form", error: null };
      }
      if (name === "grant_solidgate_pwa_entitlement") {
        mocks.upsertEntitlement({ userId: args.p_user_id, orderId: args.p_order_db_id });
        return { data: true, error: null };
      }
      if (name === "write_solidgate_account_vault_with_method") {
        return { data: null, error: { message: "vault unavailable" } };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({ p_card_token: null }),
    );
  });

  it("does not grant or vault when the hosted-form capture state cannot be published", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        product_name: "Provider catalog label",
      },
      transactions: {
        tx1: {
          status: "success",
          operation: "settle",
          amount: 3000,
          currency: "EUR",
          card_token: { token: "tok-unpublished" },
        },
      },
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "record_solidgate_pwa_confirmed_capture") {
        return { data: "invalid", error: null };
      }
      throw new Error(`Unexpected rpc after rejected capture publication: ${name}`);
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Failed to record captured purchase",
    });
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("rejects a user-linked funnel main order before reading provider status", async () => {
    const funnelOrderId = "22222222-2222-2222-2222-222222222222:trial1:1";
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        session_id: "22222222-2222-2222-2222-222222222222",
        product_name: "BRAND_000000_SUB",
        product_slug: "BRAND_000000_SUB",
        amount_cents: 500,
      },
      error: null,
    });

    const response = await POST(request(funnelOrderId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_purchase_binding",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it("rejects a non-canonical PWA order id", async () => {
    const response = await POST(request(`u-${user.id}:oto3_bundle_all:01`));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_purchase_binding",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it("rejects an order-id product that does not match the persisted PWA product", async () => {
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        product_name: "BRANDBUNDLE1_000000_PDF",
        product_slug: "BRANDBUNDLE1_000000_PDF",
        amount_cents: 2000,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_purchase_binding",
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it("rejects a canonical account order for a product outside the PWA allowlist", async () => {
    const disallowedOrderId = `u-${user.id}:trial1:1`;
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        product_name: "BRAND_000000_SUB",
        product_slug: "BRAND_000000_SUB",
        amount_cents: 500,
      },
      error: null,
    });

    const response = await POST(request(disallowedOrderId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_purchase_binding",
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it.each([
    ["metadata locale", {
      tracking_metadata: { ...order.tracking_metadata, locale: "en" },
    }],
  ])("rejects a persisted PWA %s that disagrees with its immutable identity", async (_field, patch) => {
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: { ...order, ...patch },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_purchase_binding",
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it("confirms an immutable historical amount/currency after the live catalog changes", async () => {
    const historicalOrder = {
      ...order,
      amount_cents: 2999,
      solidgate_original_amount_cents: 2999,
      currency: "gbp",
    };
    mocks.ordersMaybeSingle.mockResolvedValue({ data: historicalOrder, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 2999,
        currency: "GBP",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      transactions: {
        historical: {
          ...settleTransaction("historical", 2999),
          currency: "GBP",
        },
      },
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment: { amount_cents: 2999, currency: "GBP" },
    });
  });

  it("rejects a local money binding change during provider confirmation", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });
    mocks.ordersMaybeSingle
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({
        data: { ...order, solidgate_original_amount_cents: 2999 },
        error: null,
      });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "payment_mismatch" });
    expectNoPurchaseMutation();
  });

  it.each([
    ["original amount", { amount: 2999 }],
    ["currency", { currency: "USD" }],
    ["customer", { customer_account_id: "other-account" }],
    ["order id", { order_id: `u-${user.id}:oto3_bundle_all:2` }],
    ["unexpected product", { product_id: "unexpected-product" }],
  ])("rejects a successful provider settlement with mismatched %s", async (_field, providerOrder) => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        ...providerOrder,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "payment_mismatch" });
    expectNoPurchaseMutation();
  });

  it("returns no commerce event while Solidgate is still settling", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "processing",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      pending: true,
      status: "processing",
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it("blocks a documented refunded card status instead of leaving confirmation pending", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "refunded",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 3000,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "grant_revoked" });
    expectNoPurchaseMutation();
  });

  it("deduplicates singular and mapped transactions for an exact partial capture", async () => {
    const transaction = settleTransaction("tx-partial", 3000);
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "partial_settled",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      transaction,
      transactions: { "tx-partial": transaction },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
  });

  it("sums distinct successful settle transactions for an exact partial capture", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "partial_settled",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      transactions: {
        "tx-partial-1000": settleTransaction("tx-partial-1000", 1000),
        "tx-partial-2000": settleTransaction("tx-partial-2000", 2000),
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
  });

  it.each([
    ["under-capture", {
      transaction: settleTransaction("tx-under", 2999),
    }],
    ["conflicting duplicate", {
      transaction: settleTransaction("tx-conflict", 3000),
      transactions: { "tx-conflict": settleTransaction("tx-conflict", 1500) },
    }],
  ])("keeps ambiguous partial settlement pending for %s", async (_case, transactionShape) => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "partial_settled",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      ...transactionShape,
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      pending: true,
      status: "partial_settled",
    });
    expectNoPurchaseMutation();
  });

  it("keeps an already-completed happy-path confirmation retry idempotent", async () => {
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: { ...order, status: "completed", solidgate_payment_status: "settle_ok" },
      error: null,
    });
    mocks.entitlementsMaybeSingle.mockResolvedValue({
      data: { status: "active", revoked_at: null },
      error: null,
    });
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertEntitlement).toHaveBeenCalledOnce();
  });

  it("requires the addon_direct product and locale-currency price exactly", async () => {
    const addonOrderId = `u-${user.id}:oto2_addon_weekly:1`;
    const addonOrder = {
      ...order,
      product_name: "BRANDADDON_000000_SUB",
      product_slug: "BRANDADDON_000000_SUB",
      amount_cents: 4900,
      solidgate_original_amount_cents: 4900,
      solidgate_product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      tracking_metadata: {
        funnel_code: "PWA",
        funnel_variant: "member_area",
        session_id: `u-${user.id}`,
        product_slug: "oto2_addon_weekly",
        price_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
    };
    mocks.ordersMaybeSingle.mockResolvedValue({ data: addonOrder, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: addonOrderId,
        status: "settle_ok",
        amount: 4900,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        subscription_id: "sub-addon",
        product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
      transactions: {
        "tx-addon-settle": settleTransaction("tx-addon-settle", 4900),
      },
    });

    const response = await POST(request(addonOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      subscriptionId: "sub-addon",
      payment: {
        solidgate_product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
        price_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        solidgate_subscription_id: "sub-addon",
        solidgate_payment_status: "settle_ok",
      }),
    );
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        accessLevel: "full",
        expiresAt: "2026-07-23T08:50:01.000Z",
        solidgateSubscriptionId: "sub-addon",
      }),
    );
  });

  it("falls back to a finite seven-day addon period when capture time is absent", async () => {
    const addonOrderId = `u-${user.id}:oto2_addon_weekly:1`;
    const addonOrder = {
      ...order,
      product_name: "BRANDADDON_000000_SUB",
      product_slug: "BRANDADDON_000000_SUB",
      amount_cents: 4900,
      solidgate_original_amount_cents: 4900,
      solidgate_product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      tracking_metadata: {
        funnel_code: "PWA",
        funnel_variant: "member_area",
        session_id: `u-${user.id}`,
        product_slug: "oto2_addon_weekly",
        price_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
    };
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-21T12:00:00.000Z"));
    mocks.ordersMaybeSingle.mockResolvedValue({ data: addonOrder, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: addonOrderId,
        status: "settle_ok",
        amount: 4900,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        subscription_id: "sub-addon",
        product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
      transactions: {
        "tx-addon-settle": {
          ...settleTransaction("tx-addon-settle", 4900),
          created_at: "not-a-date",
          updated_at: "also-not-a-date",
        },
      },
    });

    const response = await POST(request(addonOrderId));

    expect(response.status).toBe(200);
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: "2026-07-28T12:00:00.000Z",
      }),
    );
  });

  it("accepts a historical addon price snapshot after catalog rotation", async () => {
    const addonOrderId = `u-${user.id}:oto2_addon_weekly:1`;
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        product_name: "BRANDADDON_000000_SUB",
        product_slug: "BRANDADDON_000000_SUB",
        amount_cents: 4900,
        solidgate_original_amount_cents: 4900,
        solidgate_product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
        tracking_metadata: {
          funnel_code: "PWA",
          funnel_variant: "member_area",
          session_id: `u-${user.id}`,
          product_slug: "oto2_addon_weekly",
          price_id: "wrong-price",
        },
      },
      error: null,
    });
    mocks.status.mockResolvedValue({
      order: {
        order_id: addonOrderId,
        status: "settle_ok",
        amount: 4900,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        subscription_id: "sub-historical",
        product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
      },
      transactions: {
        historical: settleTransaction("historical", 4900),
      },
    });

    const response = await POST(request(addonOrderId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      payment: { price_id: "wrong-price" },
    });
  });

  it("rejects an addon provider product mismatch without mutation", async () => {
    const addonOrderId = `u-${user.id}:oto2_addon_weekly:1`;
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        product_name: "BRANDADDON_000000_SUB",
        product_slug: "BRANDADDON_000000_SUB",
        amount_cents: 4900,
        solidgate_original_amount_cents: 4900,
        solidgate_product_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
        tracking_metadata: {
          funnel_code: "PWA",
          funnel_variant: "member_area",
          session_id: `u-${user.id}`,
          product_slug: "oto2_addon_weekly",
          price_id: "3193b79d-ee9a-4ef2-828c-bdeed862ae4e",
        },
      },
      error: null,
    });
    mocks.status.mockResolvedValue({
      order: {
        order_id: addonOrderId,
        status: "settle_ok",
        amount: 4900,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
        subscription_id: "sub-addon",
        product_id: "wrong-product",
      },
    });

    const response = await POST(request(addonOrderId));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "payment_mismatch" });
    expectNoPurchaseMutation();
  });

  it.each(["auth_failed", "declined"])(
    "persists exact verified %s status before returning retryable failure",
    async (providerStatus) => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: providerStatus,
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      terminal: true,
      orderId,
      status: providerStatus,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      status: "failed",
      solidgate_payment_status: providerStatus,
    });
    expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
    },
  );

  it("returns terminal 402 when a normalized failure webhook already won", async () => {
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        status: "failed",
        amount_cents: 0,
        solidgate_original_amount_cents: 3000,
        solidgate_payment_status: "auth_failed",
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      terminal: true,
      orderId,
      status: "auth_failed",
      code: "payment_failed",
    });
    expect(mocks.status).not.toHaveBeenCalled();
    expectNoPurchaseMutation();
  });

  it("accepts only an identical canonical terminal row after a zero-row terminal CAS", async () => {
    const webhookTerminalOrder = {
      ...order,
      status: "failed",
      amount_cents: 0,
      solidgate_original_amount_cents: 3000,
      solidgate_payment_status: "auth_failed",
    };
    mocks.ordersMaybeSingle
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: webhookTerminalOrder, error: null });
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "auth_failed",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      terminal: true,
      orderId,
      status: "auth_failed",
    });
    expect(mocks.filterCalls).toContainEqual(["amount_cents", 3000]);
    expect(mocks.filterCalls).toContainEqual(["solidgate_original_amount_cents", 3000]);
    expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it("blocks a zero-row terminal CAS when the reread terminal status differs", async () => {
    mocks.ordersMaybeSingle
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: {
          ...order,
          status: "failed",
          amount_cents: 0,
          solidgate_original_amount_cents: 3000,
          solidgate_payment_status: "void_ok",
        },
        error: null,
      });
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "auth_failed",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "grant_revoked" });
    expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it("stops before vault/entitlement when the reversal CAS affects no row", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
      transactions: {
        tx: {
          id: "tx",
          created_at: "2026-07-16 08:50:00",
          updated_at: "2026-07-16 08:50:01",
          amount: 3000,
          currency: "EUR",
          operation: "settle",
          status: "success",
          card_token: { token: "must-not-vault" },
          card: {
            bin: "411111",
            card_exp_month: "12",
            card_exp_year: 2028,
            number: "411111XXXXXX4242",
          },
        },
      },
    });
    mocks.ordersMaybeSingle
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "grant_revoked" });
    expect(mocks.filterCalls).toContainEqual(["solidgate_refunded_amount_cents", 0]);
    expect(mocks.filterCalls).toContainEqual(["solidgate_chargeback_id", null]);
    expect(mocks.filterCalls).toContainEqual(["solidgate_chargeback_status", null]);
    expect(mocks.filterCalls).toContainEqual(["solidgate_chargeback_amount_cents", 0]);
    expect(mocks.filterCalls).toContainEqual(["solidgate_original_amount_cents", 3000]);
    expect(mocks.upsertAccountVault).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });

  it("accepts a zero-row finalizer only when an identical success webhook won", async () => {
    mocks.status.mockResolvedValue({
      order: {
        order_id: orderId,
        status: "settle_ok",
        amount: 3000,
        currency: "EUR",
        refunded_amount: 0,
        customer_account_id: user.id,
      },
    });
    const webhookFinalizedOrder = {
      ...order,
      status: "completed",
      solidgate_payment_status: "settle_ok",
      solidgate_subscription_id: null,
    };
    mocks.ordersMaybeSingle
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: order, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: webhookFinalizedOrder, error: null });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.upsertEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: order.id }),
    );
  });

  it("blocks a settled-order replay after a chargeback", async () => {
    mocks.ordersMaybeSingle.mockResolvedValue({
      data: {
        ...order,
        status: "disputed",
        solidgate_chargeback_id: "chargeback-1",
        solidgate_chargeback_status: "in_progress",
        solidgate_chargeback_amount_cents: 3000,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "grant_revoked" });
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.upsertEntitlement).not.toHaveBeenCalled();
  });
});
