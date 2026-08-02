import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { drainSolidgateSubscriptionTokenSync } from "@repo/shared/solidgate/subscription-token-sync";
import {
  SolidgateClient,
  buildFormMerchantData,
  buildSolidgateOrderId,
  getSolidgateKeys,
  paymentEnvironmentForVercel,
} from "@repo/shared/solidgate";
import { routing, localePathSegment } from "@repo/i18n/routing";

/**
 * "Your payment failed — update your card."
 *
 * Solidgate has no SetupIntent, so the form performs a zero-amount auth. The
 * exact issued order is persisted before the form is built. Only the newest
 * unconsumed attempt may replace the vault and subscription tokens; a copied
 * or stale `sg_card_update` return URL is therefore harmless.
 */

export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMINAL_PROVIDER_STATUSES = new Set(["auth_failed", "declined", "void_ok"]);
const INVALID_ZERO_AUTH_STATUSES = new Set(["settle_ok", "partial_settled", "refunded"]);
const PENDING_PROVIDER_STATUSES = new Set([
  "created",
  "processing",
  "3ds_verify",
]);

const SOLIDGATE_ORIGINAL_PAYMENT_METHODS = new Set([
  "card",
  "apple-pay",
  "google-pay",
  "network-token",
  "click-to-pay",
] as const);
type SolidgateOriginalPaymentMethod =
  | "card"
  | "apple-pay"
  | "google-pay"
  | "network-token"
  | "click-to-pay";

type SolidgateCardToken = {
  token?: string;
  original_payment_method?: unknown;
};

function normalizedAuthEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function updateCardReturnUrl(request: Request, locale: string, orderId: string): string | null {
  try {
    const configured = process.env.NEXT_PUBLIC_PWA_URL;
    let origin = new URL(request.url).origin;
    if (process.env.VERCEL_ENV === "production") {
      if (!configured) return null;
      const configuredUrl = new URL(configured);
      if (
        configuredUrl.protocol !== "https:" ||
        configuredUrl.username ||
        configuredUrl.password
      ) return null;
      origin = configuredUrl.origin;
    }
    const url = new URL(
      `${localePathSegment(locale as (typeof routing.locales)[number])}/billing/update-payment`,
      origin,
    );
    url.searchParams.set("sg_card_update", orderId);
    return url.toString();
  } catch {
    return null;
  }
}

type CardTransaction = {
  id?: string;
  amount?: number;
  currency?: string;
  operation?: string;
  status?: string;
  card_token?: SolidgateCardToken;
  card?: { brand?: string; number?: string; card_token?: SolidgateCardToken };
};

type ReusableCardTransaction = {
  id: string;
  token: string;
  brand: string | null;
  number: string | null;
  originalPaymentMethod: "card" | "network-token";
};

interface OrderStatus {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    customer_account_id?: string;
    customer_email?: string;
    payment_method?: unknown;
  };
  transaction?: CardTransaction;
  transactions?: Record<string, CardTransaction>;
}

type RpcError = { message: string } | null;
type UpdateCardRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: RpcError }>;

type CardUpdateAttempt = {
  attempt_id: string;
  solidgate_order_id?: string;
  bound_customer_email: string;
  bound_checkout_locale: string;
  source_created_at?: string;
  attempt_state: "building" | "issued" | "applying" | "completed" | "failed";
  merchant_data?: unknown;
  is_current?: boolean;
  is_new?: boolean;
  should_build?: boolean;
};

function oneRow(value: unknown): CardUpdateAttempt | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = value[0];
  return row && typeof row === "object" ? row as CardUpdateAttempt : null;
}

function pending(orderId: string, status: string | null, retryAfterMs = 2_000) {
  return NextResponse.json(
    { ok: false, pending: true, orderId, status, retryAfterMs },
    { status: 202 },
  );
}

function wakeSubscriptionTokenSync(
  paymentEnvironment: "production" | "sandbox",
  userId: string,
): void {
  after(async () => {
    try {
      await drainSolidgateSubscriptionTokenSync({
        paymentEnvironment,
        userId,
        limit: 10,
      });
    } catch (error) {
      // The durable queue remains retryable by the funnel cron. Never turn a
      // successfully vaulted card into a false payment failure here.
      console.error(
        "[solidgate/update-card] background subscription-token sync failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function providerBindingMatches(
  status: NonNullable<OrderStatus["order"]>,
  orderId: string,
  userId: string,
  customerEmail: string,
): boolean {
  return (
    status.order_id === orderId &&
    status.customer_account_id === userId &&
    normalizedAuthEmail(status.customer_email) === customerEmail &&
    status.amount === 0 &&
    status.currency?.toLowerCase() === "eur"
  );
}

function optionalNonEmptyString(value: unknown): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeConsistentValue<T extends string>(
  left: T | null,
  right: T | null,
): { valid: boolean; value: T | null } {
  if (left !== null && right !== null && left !== right) {
    return { valid: false, value: null };
  }
  return { valid: true, value: left ?? right };
}

function optionalOriginalPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value == null) return { valid: true, value: null };
  if (
    typeof value !== "string"
    || !SOLIDGATE_ORIGINAL_PAYMENT_METHODS.has(value as SolidgateOriginalPaymentMethod)
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: value as SolidgateOriginalPaymentMethod };
}

function optionalOrderPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value === "token") return { valid: true, value: null };
  return optionalOriginalPaymentMethod(value);
}

function reusableCardTransaction(status: OrderStatus): ReusableCardTransaction | null {
  type NormalizedTransaction = Omit<ReusableCardTransaction, "originalPaymentMethod"> & {
    originalPaymentMethod: SolidgateOriginalPaymentMethod | null;
    amount?: number;
    currency?: string;
    operation?: string;
    status?: string;
  };

  const orderPaymentMethod = optionalOrderPaymentMethod(status.order?.payment_method);
  if (!orderPaymentMethod.valid) return null;
  const byId = new Map<string, NormalizedTransaction>();
  const add = (transaction: CardTransaction, mapId?: string): boolean => {
    const id = optionalNonEmptyString(transaction.id);
    if (!id.valid || !id.value || (mapId !== undefined && mapId !== id.value)) return false;

    const directToken = optionalNonEmptyString(transaction.card_token?.token);
    const nestedToken = optionalNonEmptyString(transaction.card?.card_token?.token);
    const directOriginalPaymentMethod = optionalOriginalPaymentMethod(
      transaction.card_token?.original_payment_method,
    );
    const nestedOriginalPaymentMethod = optionalOriginalPaymentMethod(
      transaction.card?.card_token?.original_payment_method,
    );
    const brand = optionalNonEmptyString(transaction.card?.brand);
    const number = optionalNonEmptyString(transaction.card?.number);
    if (
      !directToken.valid
      || !nestedToken.valid
      || !directOriginalPaymentMethod.valid
      || !nestedOriginalPaymentMethod.valid
      || !brand.valid
      || !number.valid
    ) return false;

    const token = mergeConsistentValue(directToken.value, nestedToken.value);
    const tokenOriginalPaymentMethod = mergeConsistentValue(
      directOriginalPaymentMethod.value,
      nestedOriginalPaymentMethod.value,
    );
    const originalPaymentMethod = tokenOriginalPaymentMethod.valid
      ? mergeConsistentValue(tokenOriginalPaymentMethod.value, orderPaymentMethod.value)
      : { valid: false, value: null };
    if (!token.valid || !originalPaymentMethod.valid) return false;

    const normalized: NormalizedTransaction = {
      id: id.value,
      amount: transaction.amount,
      currency: transaction.currency,
      operation: transaction.operation,
      status: transaction.status,
      token: token.value ?? "",
      brand: brand.value,
      number: number.value,
      originalPaymentMethod: originalPaymentMethod.value,
    };
    const existing = byId.get(id.value);
    if (!existing) {
      byId.set(id.value, normalized);
      return true;
    }
    if (
      existing.amount !== normalized.amount ||
      existing.currency !== normalized.currency ||
      existing.operation !== normalized.operation ||
      existing.status !== normalized.status
    ) return false;

    const mergedToken = mergeConsistentValue(existing.token || null, normalized.token || null);
    const mergedBrand = mergeConsistentValue(existing.brand, normalized.brand);
    const mergedNumber = mergeConsistentValue(existing.number, normalized.number);
    const mergedOriginalPaymentMethod = mergeConsistentValue(
      existing.originalPaymentMethod,
      normalized.originalPaymentMethod,
    );
    if (
      !mergedToken.valid
      || !mergedBrand.valid
      || !mergedNumber.valid
      || !mergedOriginalPaymentMethod.valid
    ) return false;
    byId.set(id.value, {
      ...existing,
      token: mergedToken.value ?? "",
      brand: mergedBrand.value,
      number: mergedNumber.value,
      originalPaymentMethod: mergedOriginalPaymentMethod.value,
    });
    return true;
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || typeof transaction !== "object" || !add(transaction, mapId)) return null;
  }

  const candidates = [...byId.values()].filter((transaction): transaction is (
    NormalizedTransaction & { originalPaymentMethod: "card" | "network-token" }
  ) => (
    transaction.status === "success" &&
    transaction.operation === "auth" &&
    transaction.amount === 0 &&
    transaction.currency?.toLowerCase() === "eur" &&
    transaction.token.length > 0 &&
    (
      transaction.originalPaymentMethod === "card"
      || transaction.originalPaymentMethod === "network-token"
    )
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json().catch(() => ({}))) as {
      orderId?: unknown;
      locale?: unknown;
    };

    const ssr = await createClient();
    const { data: auth } = await ssr.auth.getUser();
    const user = auth?.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = getSupabaseAdminClient();
    const rpc = supabase.rpc.bind(supabase) as unknown as UpdateCardRpc;
    const keys = getSolidgateKeys();

    // Step 2: reconcile the exact durable zero-auth and consume it once.
    if (typeof body.orderId === "string" && body.orderId) {
      const orderId = body.orderId;
      const { data: attemptData, error: attemptError } = await rpc(
        "get_solidgate_card_update_attempt",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_solidgate_order_id: orderId,
        },
      );
      const attempt = oneRow(attemptData);
      if (attemptError) {
        console.error("[solidgate/update-card] attempt read failed:", attemptError.message);
        return NextResponse.json({ error: "Unable to verify card update" }, { status: 503 });
      }
      if (!attempt || attempt.is_current !== true) {
        return NextResponse.json(
          { error: "Card-update attempt is stale or does not belong to this user" },
          { status: 409 },
        );
      }
      if (attempt.attempt_state === "completed") {
        wakeSubscriptionTokenSync(paymentEnvironment, user.id);
        return NextResponse.json({ ok: true, repointed: 0, accessRestored: false });
      }
      if (attempt.attempt_state === "failed" || attempt.attempt_state === "building") {
        return NextResponse.json({ error: "Card update is not confirmable" }, { status: 409 });
      }

      const client = new SolidgateClient(keys);
      const status = await client.status<OrderStatus>({ order_id: orderId });
      const providerOrder = status.order;
      if (!providerOrder) return pending(orderId, null);
      if (!providerBindingMatches(
        providerOrder,
        orderId,
        user.id,
        attempt.bound_customer_email,
      )) {
        return NextResponse.json(
          { error: "Provider card-update binding mismatch" },
          { status: 409 },
        );
      }

      const providerStatus = providerOrder.status ?? null;
      if (providerStatus !== "auth_ok") {
        const terminal = Boolean(providerStatus && (
          TERMINAL_PROVIDER_STATUSES.has(providerStatus) ||
          INVALID_ZERO_AUTH_STATUSES.has(providerStatus)
        ));
        const { data: recorded, error: recordError } = await rpc(
          "record_solidgate_card_update_attempt_status",
          {
            p_payment_environment: paymentEnvironment,
            p_user_id: user.id,
            p_solidgate_order_id: orderId,
            p_provider_status: providerStatus,
            p_terminal: terminal,
          },
        );
        if (terminal) {
          if (recordError || recorded !== true) {
            console.error(
              "[solidgate/update-card] terminal state persistence failed:",
              recordError?.message ?? "lost exact-order state",
            );
            return NextResponse.json(
              { error: "Unable to record terminal card update" },
              { status: 503 },
            );
          }
          return NextResponse.json(
            { error: "Card not authorised", status: providerStatus, terminal: true },
            { status: 402 },
          );
        }
        // Unknown non-terminal states are ambiguous too. Never turn a delayed
        // 3DS/provider transition into a false decline.
        return pending(
          orderId,
          providerStatus,
          providerStatus && PENDING_PROVIDER_STATUSES.has(providerStatus) ? 2_000 : 5_000,
        );
      }

      const transaction = reusableCardTransaction(status);
      const token = transaction?.token;
      if (!token) return pending(orderId, providerStatus);

      const applyToken = randomUUID();
      const { data: claimData, error: claimError } = await rpc(
        "claim_solidgate_card_update_attempt",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_solidgate_order_id: orderId,
          p_apply_token: applyToken,
        },
      );
      if (claimError) {
        console.error("[solidgate/update-card] consume claim failed:", claimError.message);
        return NextResponse.json({ error: "Unable to apply card update" }, { status: 503 });
      }
      if (claimData === "completed") {
        return NextResponse.json({ ok: true, repointed: 0, accessRestored: false });
      }
      if (claimData === "busy") return pending(orderId, providerStatus);
      if (claimData !== "acquired") {
        return NextResponse.json({ error: "Card-update attempt is no longer current" }, { status: 409 });
      }

      const releaseClaim = async () => {
        await rpc("release_solidgate_card_update_attempt", {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_solidgate_order_id: orderId,
          p_apply_token: applyToken,
          p_provider_status: providerStatus,
        });
      };

      const maskedNumber = transaction.number;
      const last4 = maskedNumber?.replace(/\D/g, "").slice(-4) || null;
      const { data: vaultResult, error: vaultError } = await rpc(
        "write_solidgate_account_vault_with_method",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_source_kind: "card_update",
          p_source_id: attempt.attempt_id,
          p_source_claim_token: applyToken,
          p_card_token: token,
          p_card_brand: transaction.brand,
          p_card_last4: last4,
          p_original_payment_method: transaction.originalPaymentMethod,
        },
      );
      if (vaultError || !["written", "same", "stale"].includes(String(vaultResult))) {
        await releaseClaim();
        console.error(
          "[solidgate/update-card] vault update failed:",
          vaultError?.message ?? `unexpected vault result: ${String(vaultResult)}`,
        );
        return pending(orderId, providerStatus);
      }

      const { data: completed, error: completeError } = await rpc(
        "complete_solidgate_card_update_attempt",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_solidgate_order_id: orderId,
          p_apply_token: applyToken,
          p_provider_status: providerStatus,
        },
      );
      if (completeError || completed !== true) {
        console.error(
          "[solidgate/update-card] consume completion failed:",
          completeError?.message ?? "lost exact-order completion claim",
        );
        return pending(orderId, providerStatus);
      }

      wakeSubscriptionTokenSync(paymentEnvironment, user.id);
      // Updating a token is not payment proof. Access is restored only by a
      // later successful renewal/order webhook.
      return NextResponse.json({
        ok: true,
        repointed: 0,
        syncPending: true,
        accessRestored: false,
      });
    }

    // Step 1: atomically issue or resume the newest zero-auth form.
    const customerEmail = normalizedAuthEmail(user.email);
    if (!customerEmail) {
      return NextResponse.json(
        { error: "A valid authenticated email is required to update the card" },
        { status: 409 },
      );
    }
    const locale = typeof body.locale === "string" &&
      (routing.locales as readonly string[]).includes(body.locale)
      ? body.locale
      : routing.defaultLocale;
    const candidateOrderId = buildSolidgateOrderId(`u-${user.id}`, "card_update", Date.now());
    const builderToken = randomUUID();
    const { data: openedData, error: openedError } = await rpc(
      "open_solidgate_card_update_attempt",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_candidate_order_id: candidateOrderId,
        p_customer_email: customerEmail,
        p_checkout_locale: locale,
        p_builder_token: builderToken,
      },
    );
    const opened = oneRow(openedData);
    if (openedError || !opened?.solidgate_order_id) {
      console.error(
        "[solidgate/update-card] attempt open failed:",
        openedError?.message ?? "unexpected opener result",
      );
      return NextResponse.json({ error: "Unable to open card update" }, { status: 503 });
    }
    const orderId = opened.solidgate_order_id;
    if (opened.attempt_state === "applying") return pending(orderId, "applying");
    if (opened.merchant_data && typeof opened.merchant_data === "object") {
      return NextResponse.json({ merchantData: opened.merchant_data, orderId });
    }
    if (opened.should_build !== true) return pending(orderId, "building", 500);

    const successUrl = updateCardReturnUrl(request, opened.bound_checkout_locale, orderId);
    if (!successUrl) {
      return NextResponse.json(
        { error: "Payment return URL is not configured" },
        { status: 500 },
      );
    }
    const forwardedIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim();
    const ip = forwardedIp || (process.env.VERCEL_ENV === "production" ? null : "127.0.0.1");
    if (!ip) return NextResponse.json({ error: "Client IP is unavailable" }, { status: 400 });

    const merchantData = await buildFormMerchantData(keys.publicKey, keys.secretKey, {
      order_id: orderId,
      order_description: "Card update",
      amount: 0,
      currency: "EUR",
      customer_account_id: user.id,
      customer_email: opened.bound_customer_email,
      ip_address: ip,
      platform: "WEB",
      success_url: successUrl,
      fail_url: successUrl,
      order_metadata: { user_id: user.id, kind: "card_update" },
    });

    const { data: finalized, error: finalizeError } = await rpc(
      "finalize_solidgate_card_update_attempt",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_attempt_id: opened.attempt_id,
        p_solidgate_order_id: orderId,
        p_builder_token: builderToken,
        p_merchant_data: merchantData,
      },
    );
    if (finalizeError || finalized !== true) {
      console.error(
        "[solidgate/update-card] form finalization failed:",
        finalizeError?.message ?? "lost exact-order builder claim",
      );
      return NextResponse.json({ error: "Unable to initialize card update" }, { status: 503 });
    }

    return NextResponse.json({ merchantData, orderId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[solidgate/update-card]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
