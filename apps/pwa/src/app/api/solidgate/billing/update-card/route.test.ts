import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  status: vi.fn(),
  after: vi.fn(),
  drainTokenSync: vi.fn(),
  buildFormMerchantData: vi.fn(),
  buildSolidgateOrderId: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: vi.fn(() => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  };
});

vi.mock("@repo/shared/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    rpc: mocks.rpc,
  })),
}));

vi.mock("@repo/shared/solidgate/subscription-token-sync", () => ({
  drainSolidgateSubscriptionTokenSync: mocks.drainTokenSync,
}));

vi.mock("@repo/shared/solidgate", () => ({
  SolidgateClient: class {
    status = mocks.status;
  },
  getSolidgateKeys: vi.fn(() => ({ publicKey: "public", secretKey: "secret" })),
  buildFormMerchantData: mocks.buildFormMerchantData,
  buildSolidgateOrderId: mocks.buildSolidgateOrderId,
  paymentEnvironmentForVercel: (vercelEnvironment: string | undefined) =>
    vercelEnvironment === "production" ? "production" : "sandbox",
}));

import { POST } from "./route";

const user = { id: "11111111-1111-1111-1111-111111111111", email: "buyer@example.com" };
const orderId = `u-${user.id}:card_update:1`;
const attemptId = "22222222-2222-4222-8222-222222222222";

function request(body: object, headers?: HeadersInit) {
  return new Request("https://app.example.com/api/solidgate/billing/update-card", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function providerOrder(overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    status: "auth_ok",
    amount: 0,
    currency: "EUR",
    customer_account_id: user.id,
    customer_email: user.email,
    ...overrides,
  };
}

function exactAttempt(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: attemptId,
    bound_customer_email: user.email,
    bound_checkout_locale: "en",
    attempt_state: "issued",
    is_current: true,
    ...overrides,
  };
}

function successfulZeroAuth(id = "auth", overrides: Record<string, unknown> = {}) {
  return {
    id,
    amount: 0,
    currency: "EUR",
    operation: "auth",
    status: "success",
    card_token: { token: "card-token", original_payment_method: "card" },
    ...overrides,
  };
}

describe("Solidgate update-card route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VERCEL_ENV = "preview";
    delete process.env.NEXT_PUBLIC_PWA_URL;
    mocks.getUser.mockResolvedValue({ data: { user } });
    mocks.drainTokenSync.mockResolvedValue({ claimed: 1, completed: 1, failed: 0, lost: 0 });
    mocks.after.mockImplementation((callback: () => unknown) => { void callback(); });
    mocks.buildSolidgateOrderId.mockReturnValue(orderId);
    mocks.buildFormMerchantData.mockResolvedValue({ merchant: "data" });
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      switch (name) {
        case "get_solidgate_card_update_attempt":
          return { data: [exactAttempt()], error: null };
        case "open_solidgate_card_update_attempt":
          return {
            data: [{
              ...exactAttempt({
                solidgate_order_id: orderId,
                attempt_state: "building",
                is_new: true,
                should_build: true,
                merchant_data: null,
              }),
              bound_customer_email: String(args.p_customer_email),
              bound_checkout_locale: String(args.p_checkout_locale),
            }],
            error: null,
          };
        case "claim_solidgate_card_update_attempt":
          return { data: "acquired", error: null };
        case "write_solidgate_account_vault_with_method":
          return { data: "written", error: null };
        case "finalize_solidgate_card_update_attempt":
        case "release_solidgate_card_update_attempt":
        case "complete_solidgate_card_update_attempt":
        case "record_solidgate_card_update_attempt_status":
          return { data: true, error: null };
        default:
          throw new Error(`unexpected RPC ${name}`);
      }
    });
  });

  it("queues subscription re-pointing and marks the exact attempt consumed", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transactions: {
        auth: {
          ...successfulZeroAuth(),
          card: { brand: "visa", number: "411111******1111" },
        },
      },
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      repointed: 0,
      syncPending: true,
      accessRestored: false,
    });
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.drainTokenSync).toHaveBeenCalledWith({
      paymentEnvironment: "sandbox",
      userId: user.id,
      limit: 10,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({
        p_source_kind: "card_update",
        p_source_id: attemptId,
        p_card_token: "card-token",
        p_original_payment_method: "card",
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_solidgate_card_update_attempt",
      expect.objectContaining({ p_solidgate_order_id: orderId }),
    );
  });

  it("uses signed order payment_method when Payment Form omits token provenance", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder({ payment_method: "card" }),
      transaction: successfulZeroAuth("auth", {
        card_token: {
          token: "card-token",
          original_payment_method: undefined,
        },
      }),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({
        p_card_token: "card-token",
        p_original_payment_method: "card",
      }),
    );
  });

  it("does not vault a mapped transaction whose key does not equal its provider id", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transactions: { unexpected: successfulZeroAuth("auth") },
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "claim_solidgate_card_update_attempt",
      expect.anything(),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("does not vault contradictory direct and nested card tokens", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", {
        card: { card_token: { token: "different-token" } },
      }),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("accepts an aligned nested network token for a card update", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", {
        card_token: undefined,
        card: {
          brand: "visa",
          number: "411111******1111",
          card_token: {
            token: "network-token",
            original_payment_method: "network-token",
          },
        },
      }),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({
        p_card_token: "network-token",
        p_original_payment_method: "network-token",
      }),
    );
  });

  it.each([
    [
      "missing payment-method provenance",
      { card_token: { token: "card-token" } },
    ],
    [
      "an unknown payment-method provenance",
      {
        card_token: {
          token: "card-token",
          original_payment_method: "unknown-wallet",
        },
      },
    ],
    [
      "conflicting direct and nested payment-method provenance",
      {
        card: {
          card_token: {
            token: "card-token",
            original_payment_method: "network-token",
          },
        },
      },
    ],
    [
      "a card authorization marked as Apple Pay",
      {
        card_token: {
          token: "card-token",
          original_payment_method: "apple-pay",
        },
      },
    ],
    [
      "an Apple Pay wallet operation",
      {
        operation: "apple-pay",
        card_token: {
          token: "wallet-token",
          original_payment_method: "apple-pay",
        },
      },
    ],
  ])("does not apply a card update with %s", async (_case, overrides) => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", overrides),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "claim_solidgate_card_update_attempt",
      expect.anything(),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "complete_solidgate_card_update_attempt",
      expect.anything(),
    );
  });

  it("does not vault contradictory duplicate transaction card data", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", {
        card: { brand: "visa" },
      }),
      transactions: {
        auth: successfulZeroAuth("auth", {
          card: { brand: "mastercard" },
        }),
      },
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it.each([
    ["a settlement", { operation: "settle" }],
    ["a non-zero authorization", { amount: 1 }],
    ["a different currency", { currency: "USD" }],
  ])("does not vault %s even when it carries a reusable token", async (_case, overrides) => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", overrides),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("does not choose between multiple distinct successful zero-auth tokens", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transactions: {
        auth1: successfulZeroAuth("auth1"),
        auth2: successfulZeroAuth("auth2", {
          card_token: {
            token: "other-token",
            original_payment_method: "card",
          },
        }),
      },
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it.each(["created", "processing", "3ds_verify"])(
    "keeps an exact %s provider state retryable",
    async (status) => {
      mocks.status.mockResolvedValue({ order: providerOrder({ status }) });

      const response = await POST(request({ orderId }));

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        pending: true,
        orderId,
        status,
      });
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "write_solidgate_account_vault_with_method",
        expect.anything(),
      );
      expect(mocks.rpc).toHaveBeenCalledWith(
        "record_solidgate_card_update_attempt_status",
        expect.objectContaining({ p_terminal: false, p_provider_status: status }),
      );
    },
  );

  it.each(["auth_failed", "declined", "void_ok", "settle_ok"])(
    "retires an explicit terminal or invalid zero-auth state %s",
    async (status) => {
      mocks.status.mockResolvedValue({ order: providerOrder({ status }) });

      const response = await POST(request({ orderId }));

      expect(response.status).toBe(402);
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "write_solidgate_account_vault_with_method",
        expect.anything(),
      );
      expect(mocks.rpc).toHaveBeenCalledWith(
        "record_solidgate_card_update_attempt_status",
        expect.objectContaining({ p_terminal: true, p_provider_status: status }),
      );
    },
  );

  it("rejects provider identity, currency, or amount drift", async () => {
    mocks.status.mockResolvedValue({ order: providerOrder({ amount: 100 }) });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("rejects a stale return URL before reading Solidgate", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [exactAttempt({ is_current: false })], error: null });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(409);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("replays a completed current attempt without re-vaulting its old token", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [exactAttempt({ attempt_state: "completed" })],
      error: null,
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
    expect(mocks.drainTokenSync).toHaveBeenCalledOnce();
  });

  it("returns retryable pending when another request owns the consume lease", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth(),
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "get_solidgate_card_update_attempt") {
        return { data: [exactAttempt()], error: null };
      }
      if (name === "claim_solidgate_card_update_attempt") {
        return { data: "busy", error: null };
      }
      return { data: true, error: null };
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(202);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.anything(),
    );
  });

  it("consumes but never reapplies a card older than the account vault winner", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth("auth", {
        card_token: {
          token: "old-card-token",
          original_payment_method: "card",
        },
      }),
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "get_solidgate_card_update_attempt") {
        return { data: [exactAttempt()], error: null };
      }
      if (name === "claim_solidgate_card_update_attempt") {
        return { data: "acquired", error: null };
      }
      if (name === "write_solidgate_account_vault_with_method") {
        return { data: "stale", error: null };
      }
      return { data: true, error: null };
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      repointed: 0,
      syncPending: true,
      accessRestored: false,
    });
    expect(mocks.drainTokenSync).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_solidgate_card_update_attempt",
      expect.objectContaining({ p_solidgate_order_id: orderId }),
    );
  });

  it("returns immediately when the durable background subscription sync is unavailable", async () => {
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transactions: { auth: successfulZeroAuth() },
    });
    mocks.drainTokenSync.mockRejectedValue(new Error("Solidgate unavailable"));

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, syncPending: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_solidgate_card_update_attempt",
      expect.objectContaining({ p_solidgate_order_id: orderId }),
    );
  });

  it.each([undefined, "", "not-an-email"])(
    "rejects an unbindable authenticated email %s before issuing an attempt",
    async (email) => {
      mocks.getUser.mockResolvedValue({ data: { user: { ...user, email } } });

      const response = await POST(request({}));

      expect(response.status).toBe(409);
      expect(mocks.buildSolidgateOrderId).not.toHaveBeenCalled();
      expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("still verifies an issued exact attempt if the current auth email changed", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { ...user, email: undefined } } });
    mocks.status.mockResolvedValue({
      order: providerOrder(),
      transaction: successfulZeroAuth(),
    });

    const response = await POST(request({ orderId }));

    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith({ order_id: orderId });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "write_solidgate_account_vault_with_method",
      expect.objectContaining({ p_card_token: "card-token" }),
    );
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
  });

  it("normalizes and durably binds the authenticated email before form creation", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { ...user, email: "  BUYER@EXAMPLE.COM " } },
    });

    const response = await POST(request({}, { "x-forwarded-for": "203.0.113.10" }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "open_solidgate_card_update_attempt",
      expect.objectContaining({ p_customer_email: "buyer@example.com" }),
    );
    expect(mocks.buildFormMerchantData).toHaveBeenCalledWith(
      "public",
      "secret",
      expect.objectContaining({ customer_email: "buyer@example.com" }),
    );
  });

  it("uses the same exact localized URL for successful and failed full-page 3DS", async () => {
    const response = await POST(request(
      { locale: "cs" },
      { "x-forwarded-for": "203.0.113.10" },
    ));
    const returnUrl =
      `https://app.example.com/cz/billing/update-payment?sg_card_update=${encodeURIComponent(orderId)}`;

    expect(response.status).toBe(200);
    expect(mocks.buildFormMerchantData).toHaveBeenCalledWith(
      "public",
      "secret",
      expect.objectContaining({ success_url: returnUrl, fail_url: returnUrl }),
    );
  });

  it("fails closed when the production return origin is missing", async () => {
    process.env.VERCEL_ENV = "production";

    const response = await POST(request({}, { "x-forwarded-for": "203.0.113.10" }));

    expect(response.status).toBe(500);
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
  });

  it("does not invent a public IP in production", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.NEXT_PUBLIC_PWA_URL = "https://app.example.com";

    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
  });

  it("returns a cached durable form without rebuilding it", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [exactAttempt({
        solidgate_order_id: orderId,
        attempt_state: "issued",
        merchant_data: { cached: true },
        should_build: false,
      })],
      error: null,
    });

    const response = await POST(request({}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      merchantData: { cached: true },
      orderId,
    });
    expect(mocks.buildFormMerchantData).not.toHaveBeenCalled();
  });
});
