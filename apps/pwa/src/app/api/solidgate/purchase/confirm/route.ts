import { after, NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import {
  buildSolidgateOrderId,
  parseSolidgateOrderId,
  paymentEnvironmentForVercel,
  SOLIDGATE_CONFIRM_GRANTABLE_ORDER_STATUSES,
  solidgateGrantBlockReason,
  SolidgateClient,
  getSolidgateKeys,
  type ParsedSolidgateOrderId,
  type PaymentEnvironment,
} from "@repo/shared/solidgate";
import { PRODUCT_ID_TO_CODE } from "@repo/shared/solidgate/catalog";
import { drainSolidgateSubscriptionTokenSync } from "@repo/shared/solidgate/subscription-token-sync";
import type { ProductId } from "@repo/shared/price-map";
import { buildConfirmedPurchase } from "@/lib/analytics/payment-event";
import {
  PWA_PRODUCT_IDS,
  PWA_SUBSCRIPTION_PERIOD_MS,
  PWA_SUBSCRIPTION_PRODUCT,
} from "@/lib/pwa-products";

/**
 * Recognises a member-area purchase.
 *
 * The client's "it worked" is a claim; this re-reads the order from Solidgate
 * with our keys before anything is granted. It also vaults the card the buyer
 * just entered, so their next purchase is one click.
 *
 * Called both after the hosted form succeeds and right after a one-click charge
 * (the charge route returns confirmRequired) — one place decides what a purchase
 * means.
 */

export const dynamic = "force-dynamic";

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

type CardStatusTransaction = {
  id?: string;
  created_at?: string;
  updated_at?: string;
  amount?: number;
  currency?: string;
  operation?: string;
  status?: string;
  card_token?: SolidgateCardToken;
  card?: {
    brand?: string;
    number?: string;
    card_token?: SolidgateCardToken;
  };
};

type NormalizedCardStatusTransaction = CardStatusTransaction & {
  id: string;
  resolvedCardToken: string | null;
  resolvedCardBrand: string | null;
  resolvedCardNumber: string | null;
  resolvedOriginalPaymentMethod: SolidgateOriginalPaymentMethod | null;
};

interface OrderStatus {
  order?: {
    status?: string;
    amount?: number;
    currency?: string;
    subscription_id?: string | null;
    product_id?: string;
    product_name?: string;
    order_id?: string;
    customer_account_id?: string;
    customer_email?: string;
    payment_method?: unknown;
  };
  transaction?: CardStatusTransaction;
  transactions?: Record<string, CardStatusTransaction>;
}

const ORDER_GRANT_COLUMNS = "id,user_id,session_id,psp,product_name,product_slug,amount_cents,currency,status,created_at,tracking_metadata,solidgate_subscription_id,solidgate_payment_status,solidgate_original_amount_cents,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,solidgate_checkout_identity_legacy" as const;

/**
 * The generated Database types mark every RPC TEXT/UUID argument as
 * non-nullable, but the SQL signatures accept NULL — a one-time purchase has no
 * subscription id, a confirmation-side write has no claim token, and a
 * non-subscription entitlement has no expiry. Passing null is correct; this
 * only silences the generated-type mismatch at the call site.
 */
function nullableRpcArg<T>(value: T | null | undefined): T {
  return value as T;
}

const DURABLE_TERMINAL_PROVIDER_STATUSES = new Set(["auth_failed", "declined", "void_ok"]);
const CARD_TERMINAL_PROVIDER_STATUSES = new Set(["auth_failed", "declined", "void_ok"]);

/**
 * Fail-closed: only a product code derived from PWA_SLUGS can ever be granted
 * here, so an order for anything else (a funnel OTO, an unknown code) is
 * rejected rather than guessed at. The set is shared with purchase/route.ts —
 * the opener and the granter must never drift apart.
 */
type PwaProductId = ProductId;

const PWA_PRODUCT_BY_CODE: ReadonlyMap<string, PwaProductId> = new Map(
  PWA_PRODUCT_IDS.map((productId) => [PRODUCT_ID_TO_CODE[productId], productId]),
);

type BoundOrder = {
  id: string;
  user_id: string | null;
  session_id: string | null;
  psp: string;
  product_name: string;
  product_slug: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  tracking_metadata: unknown;
  solidgate_subscription_id: string | null;
  solidgate_payment_status: string | null;
  solidgate_original_amount_cents: number | null;
  solidgate_refunded_amount_cents: number;
  solidgate_chargeback_id: string | null;
  solidgate_chargeback_status: string | null;
  solidgate_chargeback_amount_cents: number;
  solidgate_customer_email: string | null;
  solidgate_checkout_locale: string | null;
  solidgate_product_id: string | null;
  solidgate_payment_action: string | null;
  solidgate_checkout_identity_legacy: boolean;
};

type BoundPwaPurchase = {
  orderDbId: string;
  accountRef: string;
  customerAccountId: string;
  productId: PwaProductId;
  productCode: string;
  amountCents: number;
  currency: string;
  isSubscription: boolean;
  solidgateProductId: string | null;
  solidgateProductPriceId: string | null;
  customerEmail: string;
  checkoutLocale: string;
};

function wakeSubscriptionTokenSync(
  paymentEnvironment: PaymentEnvironment,
  userId: string,
): void {
  after(async () => {
    try {
      await drainSolidgateSubscriptionTokenSync({ paymentEnvironment, userId, limit: 10 });
    } catch (error) {
      // The queue is durable and cron retries it. Never delay or overturn a
      // confirmed purchase while provider subscription tokens are refreshed.
      console.error(
        "[solidgate/purchase/confirm] background subscription-token sync failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function parseCanonicalPwaOrderId(
  orderId: string,
  userId: string,
): ParsedSolidgateOrderId | null {
  const parsed = parseSolidgateOrderId(orderId);
  const accountRef = `u-${userId}`;
  if (
    !parsed ||
    parsed.sessionId !== accountRef ||
    !Number.isSafeInteger(parsed.attempt) ||
    parsed.attempt > 999999999
  ) return null;

  try {
    return buildSolidgateOrderId(accountRef, parsed.offeringSlug, parsed.attempt) === orderId
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve purchase semantics from the row we persisted, then verify that the
 * request order id describes that exact PWA product. The order-id slug is only
 * a consistency check; it never selects the entitlement to grant.
 */
function bindPwaPurchase(
  order: BoundOrder,
  userId: string,
  parsedOrderId: ParsedSolidgateOrderId,
): BoundPwaPurchase | null {
  if (
    order.user_id !== userId ||
    order.session_id !== null ||
    order.psp !== "solidgate" ||
    !order.product_slug ||
    order.product_name !== order.product_slug ||
    order.solidgate_checkout_identity_legacy ||
    typeof order.solidgate_customer_email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.solidgate_customer_email) ||
    typeof order.solidgate_checkout_locale !== "string" ||
    order.solidgate_payment_action !== "auth_settle"
  ) {
    return null;
  }

  const productCode = order.product_slug;
  const productId = PWA_PRODUCT_BY_CODE.get(productCode);
  if (!productId || parsedOrderId.offeringSlug !== productId) return null;

  // PWA purchase rows are written with canonical lowercase currency. Looking
  // up the persisted currency in the server catalog proves both that it is a
  // supported settlement currency and that the row carries the expected price.
  const currency = typeof order.currency === "string" ? order.currency.toLowerCase() : "";
  const immutableGrossAmount = order.solidgate_original_amount_cents ?? order.amount_cents;
  if (
    order.currency !== currency ||
    !/^[a-z]{3}$/.test(currency) ||
    !Number.isSafeInteger(immutableGrossAmount) ||
    immutableGrossAmount <= 0
  ) {
    return null;
  }

  const metadata = order.tracking_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const boundMetadata = metadata as Record<string, unknown>;
  const accountRef = `u-${userId}`;
  if (
    boundMetadata.funnel_code !== "PWA" ||
    boundMetadata.funnel_variant !== "member_area" ||
    boundMetadata.session_id !== accountRef ||
    boundMetadata.product_slug !== productId
  ) return null;

  const isSubscription = productId === PWA_SUBSCRIPTION_PRODUCT;
  const solidgateProductId = isSubscription ? order.solidgate_product_id : null;
  const solidgateProductPriceId = isSubscription && typeof boundMetadata.price_id === "string"
    ? boundMetadata.price_id.trim()
    : null;
  if (isSubscription) {
    if (
      !solidgateProductId ||
      !solidgateProductPriceId ||
      Object.prototype.hasOwnProperty.call(boundMetadata, "locale")
    ) return null;
  } else {
    if (
      boundMetadata.locale !== order.solidgate_checkout_locale ||
      order.solidgate_product_id !== null ||
      Object.prototype.hasOwnProperty.call(boundMetadata, "price_id")
    ) return null;
  }

  return {
    orderDbId: order.id,
    accountRef,
    customerAccountId: userId,
    productId,
    productCode,
    amountCents: immutableGrossAmount,
    currency,
    isSubscription,
    solidgateProductId: solidgateProductId ?? null,
    solidgateProductPriceId: solidgateProductPriceId ?? null,
    customerEmail: order.solidgate_customer_email,
    checkoutLocale: order.solidgate_checkout_locale,
  };
}

function optionalCardString(value: unknown): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeCardValue<T extends string>(
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
  // A later token charge does not reveal the original credential channel.
  if (value === "token") return { valid: true, value: null };
  return optionalOriginalPaymentMethod(value);
}

function normalizedCardDetails(
  transaction: CardStatusTransaction,
  orderPaymentMethod: SolidgateOriginalPaymentMethod | null,
): {
  valid: boolean;
  token: string | null;
  brand: string | null;
  number: string | null;
  originalPaymentMethod: SolidgateOriginalPaymentMethod | null;
} {
  const directToken = optionalCardString(transaction.card_token?.token);
  const nestedToken = optionalCardString(transaction.card?.card_token?.token);
  const directOriginalPaymentMethod = optionalOriginalPaymentMethod(
    transaction.card_token?.original_payment_method,
  );
  const nestedOriginalPaymentMethod = optionalOriginalPaymentMethod(
    transaction.card?.card_token?.original_payment_method,
  );
  const brand = optionalCardString(transaction.card?.brand);
  const number = optionalCardString(transaction.card?.number);
  if (
    !directToken.valid
    || !nestedToken.valid
    || !directOriginalPaymentMethod.valid
    || !nestedOriginalPaymentMethod.valid
    || !brand.valid
    || !number.valid
  ) {
    return {
      valid: false,
      token: null,
      brand: null,
      number: null,
      originalPaymentMethod: null,
    };
  }
  const token = mergeCardValue(directToken.value, nestedToken.value);
  const tokenOriginalPaymentMethod = mergeCardValue(
    directOriginalPaymentMethod.value,
    nestedOriginalPaymentMethod.value,
  );
  const originalPaymentMethod = tokenOriginalPaymentMethod.valid
    ? mergeCardValue(tokenOriginalPaymentMethod.value, orderPaymentMethod)
    : { valid: false, value: null };
  return {
    valid: token.valid && originalPaymentMethod.valid,
    token: token.value,
    brand: brand.value,
    number: number.value,
    originalPaymentMethod: originalPaymentMethod.value,
  };
}

function cardStatusTransactions(status: OrderStatus): NormalizedCardStatusTransaction[] | null {
  const orderPaymentMethod = optionalOrderPaymentMethod(status.order?.payment_method);
  if (!orderPaymentMethod.valid) return null;
  const byId = new Map<string, NormalizedCardStatusTransaction>();
  const add = (transaction: CardStatusTransaction, mapId?: string): boolean => {
    const parsedId = optionalCardString(transaction.id);
    const id = parsedId.valid ? parsedId.value : null;
    if (!id || (mapId != null && mapId !== id)) return false;
    const details = normalizedCardDetails(transaction, orderPaymentMethod.value);
    if (!details.valid) return false;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        ...transaction,
        id,
        resolvedCardToken: details.token,
        resolvedCardBrand: details.brand,
        resolvedCardNumber: details.number,
        resolvedOriginalPaymentMethod: details.originalPaymentMethod,
      });
      return true;
    }
    if (
      existing.amount !== transaction.amount ||
      existing.currency !== transaction.currency ||
      existing.operation !== transaction.operation ||
      existing.status !== transaction.status
    ) return false;
    const token = mergeCardValue(existing.resolvedCardToken, details.token);
    const brand = mergeCardValue(existing.resolvedCardBrand, details.brand);
    const number = mergeCardValue(existing.resolvedCardNumber, details.number);
    const originalPaymentMethod = mergeCardValue(
      existing.resolvedOriginalPaymentMethod,
      details.originalPaymentMethod,
    );
    const createdAt = mergeCardValue(existing.created_at ?? null, transaction.created_at ?? null);
    const updatedAt = mergeCardValue(existing.updated_at ?? null, transaction.updated_at ?? null);
    if (
      !token.valid
      || !brand.valid
      || !number.valid
      || !originalPaymentMethod.valid
      || !createdAt.valid
      || !updatedAt.valid
    ) {
      return false;
    }
    byId.set(id, {
      ...existing,
      created_at: createdAt.value ?? undefined,
      updated_at: updatedAt.value ?? undefined,
      resolvedCardToken: token.value,
      resolvedCardBrand: brand.value,
      resolvedCardNumber: number.value,
      resolvedOriginalPaymentMethod: originalPaymentMethod.value,
    });
    return true;
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function vaultablePwaCardAuthorization(
  status: OrderStatus,
  purchase: BoundPwaPurchase,
): NormalizedCardStatusTransaction | null {
  // Solidgate issues reusable card tokens on the payment authorization. The
  // order status / exact partial-settlement sum proves capture separately;
  // refund or settlement transactions are never accepted as token authority.
  const transactions = cardStatusTransactions(status);
  if (!transactions) return null;
  const candidates = transactions.filter((transaction) => (
    transaction.status === "success" &&
    transaction.amount === purchase.amountCents &&
    transaction.currency?.toLowerCase() === purchase.currency &&
    transaction.resolvedCardToken !== null &&
    (
      (
        transaction.operation === "auth"
        && (
          transaction.resolvedOriginalPaymentMethod === "card"
          || transaction.resolvedOriginalPaymentMethod === "network-token"
        )
      )
      || (
        transaction.operation === "apple-pay"
        && transaction.resolvedOriginalPaymentMethod === "apple-pay"
      )
      || (
        transaction.operation === "google-pay"
        && transaction.resolvedOriginalPaymentMethod === "google-pay"
      )
    )
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

function hasExactPartialCapture(
  status: OrderStatus,
  amountCents: number,
  currency: string,
): boolean {
  const transactions = cardStatusTransactions(status);
  if (!transactions) return false;
  let captured = 0;
  let foundSettlement = false;
  for (const transaction of transactions) {
    if (transaction.operation !== "settle" || transaction.status !== "success") continue;
    if (
      !Number.isSafeInteger(transaction.amount) ||
      (transaction.amount ?? -1) < 0 ||
      transaction.currency?.toLowerCase() !== currency
    ) return false;
    foundSettlement = true;
    captured += transaction.amount as number;
    if (!Number.isSafeInteger(captured) || captured > amountCents) return false;
  }
  return foundSettlement && captured === amountCents;
}

function solidgateEventTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = value.replace(" ", "T") + (hasTimezone ? "" : "Z");
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * A direct subscription charge buys ONE finite period (there is no in-app
 * trial). Anchor it to the latest confirmed settlement event when Solidgate
 * supplies one; older queued confirmations must not silently receive a fresh
 * period from request time.
 */
function subscriptionPeriodExpiresAt(status: OrderStatus): string {
  const captureTimes = (cardStatusTransactions(status) ?? [])
    .filter((transaction) => (
      transaction.operation === "settle" && transaction.status === "success"
    ))
    .map((transaction) => (
      solidgateEventTimeMs(transaction.updated_at) ??
      solidgateEventTimeMs(transaction.created_at)
    ))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const fallbackCapturedAt = Date.now();
  const capturedAt = captureTimes.length > 0 ? Math.max(...captureTimes) : fallbackCapturedAt;
  const expiresAt = capturedAt + PWA_SUBSCRIPTION_PERIOD_MS;
  if (Number.isFinite(expiresAt) && Number.isFinite(new Date(expiresAt).getTime())) {
    return new Date(expiresAt).toISOString();
  }
  return new Date(fallbackCapturedAt + PWA_SUBSCRIPTION_PERIOD_MS).toISOString();
}

function samePwaBinding(left: BoundPwaPurchase, right: BoundPwaPurchase): boolean {
  return (
    left.orderDbId === right.orderDbId &&
    left.accountRef === right.accountRef &&
    left.customerAccountId === right.customerAccountId &&
    left.productId === right.productId &&
    left.productCode === right.productCode &&
    left.amountCents === right.amountCents &&
    left.currency === right.currency &&
    left.isSubscription === right.isSubscription &&
    left.solidgateProductId === right.solidgateProductId &&
    left.solidgateProductPriceId === right.solidgateProductPriceId &&
    left.customerEmail === right.customerEmail &&
    left.checkoutLocale === right.checkoutLocale
  );
}

function providerPwaOrderMatches(
  order: OrderStatus["order"],
  orderId: string,
  purchase: BoundPwaPurchase,
): boolean {
  if (
    !order ||
    order.order_id !== orderId ||
    order.customer_account_id !== purchase.customerAccountId ||
    (
      typeof order.customer_email === "string" &&
      order.customer_email.trim().toLowerCase() !== purchase.customerEmail
    ) ||
    order.currency?.toLowerCase() !== purchase.currency ||
    order.amount !== purchase.amountCents
  ) return false;

  if (purchase.isSubscription) {
    if (order.product_id !== purchase.solidgateProductId) return false;
  } else if (order.product_id != null) {
    // Amount-based PWA orders never name a catalog product. Accepting an
    // unexpected provider product would let the same amount grant the wrong SKU.
    return false;
  }

  const hasSubscription =
    typeof order.subscription_id === "string" && order.subscription_id.length > 0;
  const providerStatus = order.status;
  if (providerStatus === "settle_ok" || providerStatus === "partial_settled") {
    return (
      (purchase.isSubscription ? hasSubscription : !hasSubscription)
    );
  }
  return true;
}

function pwaPaymentDecision(
  status: OrderStatus,
  purchase: BoundPwaPurchase,
): "success" | "pending" | "terminal" | "reversed" {
  const providerStatus = status.order?.status;
  if (providerStatus === "settle_ok") return "success";
  if (providerStatus === "partial_settled") {
    return hasExactPartialCapture(status, purchase.amountCents, purchase.currency)
      ? "success"
      : "pending";
  }
  if (providerStatus === "refunded") return "reversed";
  if (providerStatus && CARD_TERMINAL_PROVIDER_STATUSES.has(providerStatus)) return "terminal";
  return "pending";
}

async function replayBlockReason(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  order: BoundOrder,
) {
  const { data: entitlement, error } = await supabase
    .from("entitlements")
    .select("status, revoked_at")
    .eq("payment_environment", paymentEnvironment)
    .eq("order_id", order.id)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify entitlement state: ${error.message}`);
  return solidgateGrantBlockReason(order, entitlement);
}

function replayBlockedResponse() {
  return NextResponse.json(
    { error: "Purchase is no longer grantable", code: "grant_revoked" },
    { status: 409 },
  );
}

function invalidPwaBindingResponse() {
  return NextResponse.json(
    { error: "Order is not a valid PWA purchase", code: "invalid_purchase_binding" },
    { status: 403 },
  );
}

function settlementMismatchResponse() {
  return NextResponse.json(
    { error: "Payment does not match the opened purchase", code: "payment_mismatch" },
    { status: 409 },
  );
}

function terminalFailureResponse(orderId: string, providerStatus: string) {
  return NextResponse.json(
    {
      ok: false,
      terminal: true,
      orderId,
      status: providerStatus,
      code: providerStatus === "void_ok" ? "void_ok" : "payment_failed",
      error: providerStatus === "void_ok"
        ? "Payment authorization was voided"
        : "Payment not completed",
    },
    { status: 402 },
  );
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const { orderId } = (await request.json()) as { orderId?: unknown };
    if (typeof orderId !== "string" || !orderId) {
      return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
    }

    const ssr = await createClient();
    const { data: auth } = await ssr.auth.getUser();
    const user = auth?.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const parsedOrderId = parseCanonicalPwaOrderId(orderId, user.id);
    if (!parsedOrderId) return invalidPwaBindingResponse();

    const supabase = getSupabaseAdminClient();

    // The order must be one WE opened, for THIS user. A forged order id buys nothing.
    const { data: rawOrder, error: orderError } = await supabase
      .from("orders")
      .select(ORDER_GRANT_COLUMNS)
      .eq("payment_environment", paymentEnvironment)
      .eq("solidgate_order_id", orderId)
      .maybeSingle();
    if (orderError) {
      return NextResponse.json({ error: "Failed to verify purchase state" }, { status: 500 });
    }
    const order = rawOrder as BoundOrder | null;
    if (!order || order.user_id !== user.id) {
      return NextResponse.json({ error: "Order does not belong to this user" }, { status: 403 });
    }
    const purchase = bindPwaPurchase(order, user.id, parsedOrderId);
    if (!purchase) return invalidPwaBindingResponse();

    if (
      order.status === "failed" &&
      order.solidgate_payment_status &&
      DURABLE_TERMINAL_PROVIDER_STATUSES.has(order.solidgate_payment_status)
    ) {
      return terminalFailureResponse(orderId, order.solidgate_payment_status);
    }

    const initialBlock = await replayBlockReason(supabase, paymentEnvironment, order);
    if (initialBlock) {
      console.warn("[solidgate/purchase/confirm] blocked replay", { orderId, reason: initialBlock });
      return replayBlockedResponse();
    }

    const client = new SolidgateClient(getSolidgateKeys());
    const status = await client.status<OrderStatus>({ order_id: orderId });
    const solidgateOrder = status.order;
    const orderStatus = solidgateOrder?.status;
    if (!solidgateOrder) {
      return NextResponse.json({ ok: false, pending: true, status: null }, { status: 202 });
    }
    if (!providerPwaOrderMatches(solidgateOrder, orderId, purchase)) {
      console.error("[solidgate/purchase/confirm] provider binding mismatch", { orderId });
      return settlementMismatchResponse();
    }
    const paymentDecision = pwaPaymentDecision(status, purchase);

    if (paymentDecision !== "success") {
      if (paymentDecision === "reversed") return replayBlockedResponse();
      if (paymentDecision !== "terminal" || !orderStatus) {
        return NextResponse.json(
          { ok: false, pending: true, status: orderStatus ?? null },
          { status: 202 },
        );
      }

      let failureUpdate = supabase
        .from("orders")
        .update({ status: "failed", solidgate_payment_status: orderStatus })
        .eq("payment_environment", paymentEnvironment)
        .eq("solidgate_order_id", orderId)
        .eq("id", purchase.orderDbId)
        .eq("user_id", user.id)
        .eq("psp", "solidgate")
        .is("session_id", null)
        .eq("product_name", purchase.productCode)
        .eq("product_slug", purchase.productCode)
        .eq("amount_cents", order.amount_cents)
        .eq("currency", purchase.currency)
        .eq("solidgate_refunded_amount_cents", order.solidgate_refunded_amount_cents)
        .eq("solidgate_chargeback_amount_cents", order.solidgate_chargeback_amount_cents)
        .eq("status", "pending");
      failureUpdate = order.solidgate_payment_status == null
        ? failureUpdate.is("solidgate_payment_status", null)
        : failureUpdate.eq("solidgate_payment_status", order.solidgate_payment_status);
      failureUpdate = order.solidgate_original_amount_cents == null
        ? failureUpdate.is("solidgate_original_amount_cents", null)
        : failureUpdate.eq(
            "solidgate_original_amount_cents",
            order.solidgate_original_amount_cents,
          );
      failureUpdate = order.solidgate_subscription_id == null
        ? failureUpdate.is("solidgate_subscription_id", null)
        : failureUpdate.eq("solidgate_subscription_id", order.solidgate_subscription_id);
      failureUpdate = order.solidgate_chargeback_id == null
        ? failureUpdate.is("solidgate_chargeback_id", null)
        : failureUpdate.eq("solidgate_chargeback_id", order.solidgate_chargeback_id);
      failureUpdate = order.solidgate_chargeback_status == null
        ? failureUpdate.is("solidgate_chargeback_status", null)
        : failureUpdate.eq("solidgate_chargeback_status", order.solidgate_chargeback_status);
      const { data: failed, error: failedError } = await failureUpdate
        .select("id")
        .maybeSingle();
      if (failedError) {
        return NextResponse.json({ error: "Failed to record terminal payment" }, { status: 500 });
      }
      if (failed?.id) return terminalFailureResponse(orderId, orderStatus);

      const { data: racedRawOrder, error: racedOrderError } = await supabase
        .from("orders")
        .select(ORDER_GRANT_COLUMNS)
        .eq("payment_environment", paymentEnvironment)
        .eq("solidgate_order_id", orderId)
        .maybeSingle();
      if (racedOrderError) {
        return NextResponse.json({ error: "Failed to verify terminal payment" }, { status: 500 });
      }
      const racedOrder = racedRawOrder as BoundOrder | null;
      const racedPurchase = racedOrder
        ? bindPwaPurchase(racedOrder, user.id, parsedOrderId)
        : null;
      if (
        racedOrder?.status === "failed" &&
        racedOrder.solidgate_payment_status === orderStatus &&
        racedPurchase &&
        samePwaBinding(purchase, racedPurchase)
      ) return terminalFailureResponse(orderId, orderStatus);
      return replayBlockedResponse();
    }
    if (!orderStatus) {
      return NextResponse.json(
        { ok: false, pending: true, status: null },
        { status: 202 },
      );
    }

    // A refund/cancel/chargeback webhook can land while the provider status
    // request is in flight. Re-read our durable state; the old `settle_ok`
    // response is not authority to undo a later local revocation.
    const { data: freshRawOrder, error: freshOrderError } = await supabase
      .from("orders")
      .select(ORDER_GRANT_COLUMNS)
      .eq("payment_environment", paymentEnvironment)
      .eq("solidgate_order_id", orderId)
      .maybeSingle();
    if (freshOrderError) {
      return NextResponse.json({ error: "Failed to verify purchase state" }, { status: 500 });
    }
    const freshOrder = freshRawOrder as BoundOrder | null;
    if (!freshOrder || freshOrder.user_id !== user.id) return replayBlockedResponse();
    const freshPurchase = bindPwaPurchase(freshOrder, user.id, parsedOrderId);
    if (!freshPurchase) return invalidPwaBindingResponse();
    if (
      !samePwaBinding(purchase, freshPurchase) ||
      !providerPwaOrderMatches(solidgateOrder, orderId, freshPurchase)
    ) {
      console.error("[solidgate/purchase/confirm] refreshed binding mismatch", { orderId });
      return settlementMismatchResponse();
    }

    const freshBlock = await replayBlockReason(supabase, paymentEnvironment, freshOrder);
    if (freshBlock) {
      console.warn("[solidgate/purchase/confirm] blocked replay", { orderId, reason: freshBlock });
      return replayBlockedResponse();
    }

    const subscriptionId = freshPurchase.isSubscription
      ? solidgateOrder?.subscription_id ?? null
      : null;

    const amountCents = freshPurchase.amountCents;
    const currency = freshPurchase.currency.toUpperCase();

    let orderFinalizer = supabase
      .from("orders")
      .update({
        // 'active', not 'trialing': the member area sells the NO-trial
        // product, so the first period is charged on the spot. Calling it a
        // trial would tell the admin dashboard nobody had paid yet.
        status: freshPurchase.isSubscription ? "active" : "completed",
        solidgate_subscription_id: subscriptionId,
        solidgate_payment_status: orderStatus,
        solidgate_verify_url: null,
        solidgate_submission_token: null,
        solidgate_submission_started_at: null,
        claimed_at: new Date().toISOString(),
      })
      .eq("payment_environment", paymentEnvironment)
      .eq("solidgate_order_id", orderId)
      .eq("id", freshPurchase.orderDbId)
      .eq("user_id", user.id)
      .eq("psp", "solidgate")
      .is("session_id", null)
      .eq("product_name", freshPurchase.productCode)
      .eq("product_slug", freshPurchase.productCode)
      .eq("amount_cents", freshOrder.amount_cents)
      .eq("currency", freshPurchase.currency)
      .eq("solidgate_refunded_amount_cents", freshOrder.solidgate_refunded_amount_cents)
      .eq("solidgate_chargeback_amount_cents", freshOrder.solidgate_chargeback_amount_cents);
    orderFinalizer = freshOrder.solidgate_payment_status == null
      ? orderFinalizer.is("solidgate_payment_status", null)
      : orderFinalizer.eq("solidgate_payment_status", freshOrder.solidgate_payment_status);
    orderFinalizer = freshOrder.solidgate_original_amount_cents == null
      ? orderFinalizer.is("solidgate_original_amount_cents", null)
      : orderFinalizer.eq(
          "solidgate_original_amount_cents",
          freshOrder.solidgate_original_amount_cents,
        );
    orderFinalizer = freshOrder.solidgate_subscription_id == null
      ? orderFinalizer.is("solidgate_subscription_id", null)
      : orderFinalizer.eq("solidgate_subscription_id", freshOrder.solidgate_subscription_id);
    orderFinalizer = freshOrder.solidgate_chargeback_id == null
      ? orderFinalizer.is("solidgate_chargeback_id", null)
      : orderFinalizer.eq("solidgate_chargeback_id", freshOrder.solidgate_chargeback_id);
    orderFinalizer = freshOrder.solidgate_chargeback_status == null
      ? orderFinalizer.is("solidgate_chargeback_status", null)
      : orderFinalizer.eq("solidgate_chargeback_status", freshOrder.solidgate_chargeback_status);
    const { data: granted, error: grantOrderError } = await orderFinalizer
      .in("status", [...SOLIDGATE_CONFIRM_GRANTABLE_ORDER_STATUSES])
      .select("id")
      .maybeSingle();

    // The conditional update loses to a concurrent terminal webhook. Never
    // continue to the entitlement upsert when that happens.
    if (grantOrderError) {
      return NextResponse.json({ error: "Failed to record purchase" }, { status: 500 });
    }
    let grantedOrderId = granted?.id ?? null;
    if (!grantedOrderId) {
      // A successful webhook may have won the exact transition. Verify the
      // resulting row rather than treating every zero-row CAS as success or as
      // a reversal; only the identical terminal binding may proceed.
      const { data: finalizedRawOrder, error: finalizedOrderError } = await supabase
        .from("orders")
        .select(ORDER_GRANT_COLUMNS)
        .eq("payment_environment", paymentEnvironment)
        .eq("solidgate_order_id", orderId)
        .maybeSingle();
      if (finalizedOrderError) {
        return NextResponse.json({ error: "Failed to verify finalized purchase" }, { status: 500 });
      }
      const finalizedOrder = finalizedRawOrder as BoundOrder | null;
      const finalizedPurchase = finalizedOrder
        ? bindPwaPurchase(finalizedOrder, user.id, parsedOrderId)
        : null;
      const finalizedBlock = finalizedOrder
        ? await replayBlockReason(supabase, paymentEnvironment, finalizedOrder)
        : "order_status";
      const expectedLocalStatus = freshPurchase.isSubscription ? "active" : "completed";
      if (
        !finalizedOrder ||
        !finalizedPurchase ||
        !samePwaBinding(freshPurchase, finalizedPurchase) ||
        finalizedBlock ||
        finalizedOrder.status !== expectedLocalStatus ||
        finalizedOrder.solidgate_payment_status !== orderStatus ||
        finalizedOrder.solidgate_subscription_id !== subscriptionId
      ) return replayBlockedResponse();
      grantedOrderId = finalizedOrder.id;
    }

    // Publish or recover the exact signed capture after the order CAS. This is
    // authoritative for hosted forms and repairs a saved-card submit that moved
    // money but crashed before its claim owner persisted the result. Only the
    // hosted-form result is eligible to advance account-vault chronology.
    const { data: confirmedCaptureMode, error: confirmedCaptureError } = await supabase.rpc(
      "record_solidgate_pwa_confirmed_capture",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_offer_slug: freshPurchase.productId,
        p_product_slug: freshPurchase.productCode,
        p_order_db_id: grantedOrderId,
        p_solidgate_order_id: orderId,
        p_amount_cents: amountCents,
        p_currency: freshPurchase.currency,
        p_provider_status: orderStatus,
        p_subscription_id: nullableRpcArg(subscriptionId),
      },
    );
    if (
      confirmedCaptureError
      || !["hosted_form", "saved_card", "stale"].includes(String(confirmedCaptureMode))
    ) {
      console.error(
        "[solidgate/purchase/confirm] captured state publication failed:",
        confirmedCaptureError?.message ?? confirmedCaptureMode,
      );
      return NextResponse.json({ error: "Failed to record captured purchase" }, { status: 500 });
    }

    const { data: entitlementGranted, error: entitlementGrantError } = await supabase.rpc(
      "grant_solidgate_pwa_entitlement",
      {
        p_payment_environment: paymentEnvironment,
        p_order_db_id: grantedOrderId,
        p_user_id: user.id,
        p_product_slug: freshPurchase.productCode,
        // The member-area subscription charges immediately, so it is full
        // access from the first minute — there is no trial to be in.
        p_access_level: "full",
        p_expires_at: nullableRpcArg(
          freshPurchase.isSubscription ? subscriptionPeriodExpiresAt(status) : null,
        ),
        p_solidgate_subscription_id: nullableRpcArg(subscriptionId),
        p_source: "solidgate_pwa",
      },
    );
    // The database trigger rejects a terminal-order/revocation race even if
    // it lands in the few instructions after our second read.
    if (entitlementGrantError || entitlementGranted !== true) {
      const { data: finalRawOrder } = await supabase
        .from("orders")
        .select(ORDER_GRANT_COLUMNS)
        .eq("payment_environment", paymentEnvironment)
        .eq("solidgate_order_id", orderId)
        .maybeSingle();
      if (
        !finalRawOrder ||
        await replayBlockReason(supabase, paymentEnvironment, finalRawOrder as unknown as BoundOrder)
      ) {
        return replayBlockedResponse();
      }
      return NextResponse.json({ error: "Failed to grant purchase" }, { status: 500 });
    }

    // Access is already durable, but the hosted-form source watermark is a
    // required safety write: even a tokenless capture must hide an older card.
    // Return a retryable 5xx if it fails so a later confirmation/webhook repairs
    // chronology before the next one-click charge.
    const tx = vaultablePwaCardAuthorization(status, freshPurchase);
    const cardToken = tx?.resolvedCardToken ?? null;
    if (confirmedCaptureMode === "hosted_form") {
      const digits = tx?.resolvedCardNumber?.replace(/\D/g, "") ?? "";
      const { data: vaultResult, error: vaultError } = await supabase.rpc(
        "write_solidgate_account_vault_with_method",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_source_kind: "pwa_order",
          p_source_id: grantedOrderId,
          p_source_claim_token: nullableRpcArg<string>(null),
          p_card_token: nullableRpcArg(cardToken),
          p_card_brand: nullableRpcArg(tx?.resolvedCardBrand ?? null),
          p_card_last4: nullableRpcArg(digits.length >= 4 ? digits.slice(-4) : null),
          p_original_payment_method: nullableRpcArg(tx?.resolvedOriginalPaymentMethod ?? null),
        },
      );
      if (vaultError || !["written", "same", "stale"].includes(vaultResult ?? "")) {
        throw new Error(
          vaultError?.message ?? `unexpected vault result: ${String(vaultResult)}`,
        );
      }
      wakeSubscriptionTokenSync(paymentEnvironment, user.id);
    }

    const payment = buildConfirmedPurchase({
      orderId,
      productCode: freshPurchase.productCode,
      productName: freshOrder.product_name,
      productSlug: freshPurchase.productId,
      amountCents,
      currency,
      subscriptionId,
      solidgateProductId: freshPurchase.solidgateProductId ?? undefined,
      priceId: freshPurchase.solidgateProductPriceId ?? undefined,
    });

    return NextResponse.json({ ok: true, subscriptionId, payment });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[solidgate/purchase/confirm]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
