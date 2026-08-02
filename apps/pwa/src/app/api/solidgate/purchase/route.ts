import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import {
  resolveProductPrice,
  LOCALE_CURRENCY_MAP,
  type Locale,
  type ProductId,
} from "@repo/shared/price-map";
import {
  SolidgateClient,
  buildFormMerchantData,
  buildSolidgateOrderId,
  chargeSavedCard,
  classifySolidgatePayment,
  getSolidgateKeys,
  parseSolidgateOrderId,
  paymentTypeForOriginalPaymentMethod,
  resolveSolidgateVerifyUrl,
  paymentEnvironmentForVercel,
  solidgateCapturedAmount,
  solidgateDynamicDescriptor,
  subscribeSavedCard,
  type PaymentEnvironment,
  type SolidgateCaptureState,
  type SolidgateChargeResult,
  type SolidgateMerchantData,
  type SolidgatePaymentIntent,
} from "@repo/shared/solidgate";
import { getAccountVault } from "@repo/shared/solidgate/account-vault";
import {
  PRODUCT_ID_TO_CODE,
  SOLIDGATE_PRODUCT_CODES,
} from "@repo/shared/solidgate/catalog";
import { solidgateOrderDescription } from "@repo/shared/locale-prefixes";
import catalogIds from "@repo/shared/solidgate/catalog-ids.json";
import { routing, localePathSegment } from "@repo/i18n/routing";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";
import { normalizeAcquisitionUtm } from "@/lib/analytics/acquisition";
import {
  PWA_SLUGS,
  PWA_SUBSCRIPTION_CATALOG_KEY,
  PWA_SUBSCRIPTION_PRODUCT,
} from "@/lib/pwa-products";

/**
 * Member-area purchases are account-scoped and opened through one database
 * state machine. Solidgate has no separate idempotency key: the order id is the
 * key, so every retry must reuse an uncertain provider identity.
 */

export const dynamic = "force-dynamic";

const TERMINAL_PROVIDER_STATUSES = new Set(["auth_failed", "declined", "void_ok"]);
// Solidgate may return verify_url while the order is still `created` or
// `processing`; it only transitions to `3ds_verify` once the ACS flow starts.
const ACTIONABLE_PROVIDER_STATUSES = new Set(["created", "processing", "3ds_verify"]);
// A stored `partial_settled` status does not carry the settled total. The owner
// may prove an exact partial capture from transactions, but a later follower
// must keep it pending rather than infer full payment from the status alone.
const CAPTURED_PROVIDER_STATUSES = new Set(["settle_ok"]);
const FORM_BUILD_POLL_ATTEMPTS = 40;
const FORM_BUILD_POLL_MS = 25;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CatalogIds = Record<string, { product_id: string; prices: Record<string, string> }>;
type PurchaseMode = "saved_card" | "hosted_form";
type RpcError = { code?: string; message: string };

type OpenedPwaPurchase = {
  order_db_id: string;
  solidgate_order_id: string;
  bound_payment_environment: PaymentEnvironment;
  bound_user_id: string;
  bound_offer_slug: string;
  bound_product_slug: string;
  bound_product_name: string;
  bound_amount_cents: number;
  bound_currency: string;
  bound_order_status: string;
  bound_payment_status: string | null;
  bound_tracking_metadata: Record<string, unknown>;
  bound_customer_email: string;
  bound_checkout_locale: Locale;
  bound_solidgate_product_id: string | null;
  bound_solidgate_payment_action: "auth_settle";
  purchase_mode: PurchaseMode;
  solidgate_subscription_id: string | null;
  verify_url: string | null;
  last_result_kind: "pending" | "requires_action" | "captured" | "terminal_failure" | null;
  last_result_net_amount_cents: number | null;
  is_new: boolean;
  should_build: boolean;
  should_submit: boolean;
  needs_reconcile: boolean;
  claim_token: string | null;
  merchant_data: SolidgateMerchantData | null;
};

type PurchaseRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: RpcError | null }>;

type ProviderOrder = {
  order_id?: string;
  status?: string;
  amount?: number;
  settled_amount?: number | null;
  currency?: string;
  subscription_id?: string | null;
  product_id?: string;
  customer_account_id?: string;
};

type ProviderStatus = SolidgateCaptureState & {
  order?: ProviderOrder;
  verify_url?: string;
  verify_link?: string;
  error?: unknown;
};

type ExpectedBinding = {
  paymentEnvironment: PaymentEnvironment;
  userId: string;
  accountRef: string;
  productId: ProductId;
  productCode: string;
  amountCents: number;
  currency: string;
  locale: Locale;
  priceId: string | null;
  providerProductId: string | null;
  purchaseMode: PurchaseMode;
  claimToken: string;
  customerEmail: string;
  paymentAction: "auth_settle";
};

function purchaseRpc(supabase: ReturnType<typeof getSupabaseAdminClient>): PurchaseRpc {
  return supabase.rpc.bind(supabase) as unknown as PurchaseRpc;
}

function normalizedAuthEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

function isMerchantData(value: unknown): value is SolidgateMerchantData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.merchant === "string" && candidate.merchant.length > 0 &&
    typeof candidate.paymentIntent === "string" && candidate.paymentIntent.length > 0 &&
    typeof candidate.signature === "string" && candidate.signature.length > 0
  );
}

function asSingleReservation(value: unknown): OpenedPwaPurchase | null {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    return null;
  }
  return value[0] as OpenedPwaPurchase;
}

function canonicalMetadata(
  value: unknown,
  expected: ExpectedBinding,
): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  const values = Object.values(metadata);
  if (
    Object.keys(metadata).length > 10 ||
    values.some((entry) => typeof entry !== "string" || entry.length > 380) ||
    metadata.funnel_code !== "PWA" ||
    metadata.funnel_variant !== "member_area" ||
    metadata.session_id !== expected.accountRef ||
    metadata.product_slug !== expected.productId
  ) return false;

  if (expected.productId === PWA_SUBSCRIPTION_PRODUCT) {
    return metadata.price_id === expected.priceId && !("locale" in metadata);
  }
  return metadata.locale === expected.locale && !("price_id" in metadata);
}

function reservationMismatch(
  reservation: OpenedPwaPurchase,
  expected: ExpectedBinding,
): string | null {
  const parsed = typeof reservation.solidgate_order_id === "string"
    ? parseSolidgateOrderId(reservation.solidgate_order_id)
    : null;
  let canonicalOrderId: string | null = null;
  if (parsed) {
    try {
      canonicalOrderId = buildSolidgateOrderId(
        expected.accountRef,
        expected.productId,
        parsed.attempt,
      );
    } catch {
      canonicalOrderId = null;
    }
  }

  if (
    typeof reservation.order_db_id !== "string" ||
    !UUID_PATTERN.test(reservation.order_db_id) ||
    !parsed ||
    parsed.sessionId !== expected.accountRef ||
    parsed.offeringSlug !== expected.productId ||
    !Number.isSafeInteger(parsed.attempt) ||
    parsed.attempt > 999999999 ||
    canonicalOrderId !== reservation.solidgate_order_id
  ) return "order_id";
  if (reservation.bound_payment_environment !== expected.paymentEnvironment) return "environment";
  if (reservation.bound_user_id !== expected.userId) return "user";
  if (
    reservation.bound_offer_slug !== expected.productId ||
    reservation.bound_product_slug !== expected.productCode ||
    reservation.bound_product_name !== expected.productCode
  ) return "product";
  if (reservation.bound_amount_cents !== expected.amountCents) return "amount";
  if (reservation.bound_currency !== expected.currency.toLowerCase()) return "currency";
  if (reservation.bound_customer_email !== expected.customerEmail) return "customer_email";
  if (reservation.bound_checkout_locale !== expected.locale) return "checkout_locale";
  if (reservation.bound_solidgate_product_id !== expected.providerProductId) return "provider_product";
  if (reservation.bound_solidgate_payment_action !== expected.paymentAction) return "payment_action";
  if (!canonicalMetadata(reservation.bound_tracking_metadata, expected)) return "metadata";
  if (reservation.purchase_mode !== expected.purchaseMode) return "mode";
  if (
    reservation.bound_payment_status !== null &&
    typeof reservation.bound_payment_status !== "string"
  ) return "payment_status";
  if (
    !["pending", "completed", "active", "trialing"].includes(reservation.bound_order_status)
  ) return "order_status";
  if (
    typeof reservation.is_new !== "boolean" ||
    typeof reservation.should_build !== "boolean" ||
    typeof reservation.should_submit !== "boolean" ||
    typeof reservation.needs_reconcile !== "boolean"
  ) return "rpc_shape";

  const ownerActions = [
    reservation.should_build,
    reservation.should_submit,
    reservation.needs_reconcile,
  ].filter(Boolean).length;
  if (ownerActions > 1) return "claim_actions";
  if (ownerActions === 1 && reservation.claim_token !== expected.claimToken) return "claim_owner";
  if (ownerActions === 0 && reservation.claim_token !== null) return "claim_follower";
  if (ownerActions === 1 && reservation.bound_order_status !== "pending") {
    return "claim_order_status";
  }
  if (
    ownerActions === 1 &&
    reservation.bound_payment_status !== null &&
    reservation.bound_payment_status !== "creating"
  ) return "claim_payment_status";
  if (reservation.purchase_mode === "saved_card" && reservation.should_build) return "mode_action";
  if (
    reservation.purchase_mode === "hosted_form" &&
    (reservation.should_submit || reservation.needs_reconcile)
  ) return "mode_action";
  if (reservation.merchant_data !== null && !isMerchantData(reservation.merchant_data)) {
    return "merchant_data";
  }
  if (reservation.merchant_data !== null && reservation.purchase_mode !== "hosted_form") {
    return "merchant_mode";
  }
  if (reservation.merchant_data !== null && reservation.should_build) return "builder_state";
  if (
    reservation.solidgate_subscription_id !== null &&
    typeof reservation.solidgate_subscription_id !== "string"
  ) return "subscription";
  if (reservation.verify_url !== null && typeof reservation.verify_url !== "string") {
    return "verify_url";
  }
  if (
    reservation.last_result_kind !== null &&
    !["pending", "requires_action", "captured", "terminal_failure"].includes(
      reservation.last_result_kind,
    )
  ) return "last_result_kind";
  if (
    reservation.last_result_net_amount_cents !== null &&
    (!Number.isSafeInteger(reservation.last_result_net_amount_cents) ||
      reservation.last_result_net_amount_cents < 0)
  ) return "last_result_net";
  if (
    (reservation.last_result_kind === null &&
      reservation.last_result_net_amount_cents !== null) ||
    (reservation.last_result_kind === "terminal_failure" &&
      reservation.last_result_net_amount_cents !== 0) ||
    (reservation.last_result_kind !== null &&
      reservation.last_result_kind !== "terminal_failure" &&
      reservation.last_result_net_amount_cents !== reservation.bound_amount_cents)
  ) return "last_result_binding";
  return null;
}

function safeVerifyUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function purchaseReturnUrl(request: Request, locale: Locale, orderId: string): string | null {
  try {
    const requestOrigin = new URL(request.url).origin;
    const configured = process.env.NEXT_PUBLIC_PWA_URL;
    let origin = requestOrigin;
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
    if (!origin) return null;

    const url = new URL(`${localePathSegment(locale)}/dashboard`, origin);
    url.searchParams.set("sg_confirm", orderId);
    return url.toString();
  } catch {
    return null;
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pendingResponse(orderId: string) {
  return NextResponse.json(
    { ok: false, pending: true, accepted: false, orderId },
    { status: 202 },
  );
}

function capturedResponse(orderId: string, subscriptionId: string | null) {
  return NextResponse.json({
    ok: true,
    orderId,
    subscriptionId,
    confirmRequired: true,
  });
}

function terminalResponse(
  orderId: string,
  providerStatus: string,
  errorCode?: string,
  errorMessage?: string,
) {
  return NextResponse.json(
    {
      ok: false,
      needsNewCard: true,
      orderId,
      status: providerStatus,
      code: errorCode ?? (providerStatus === "void_ok" ? "void_ok" : "payment_failed"),
      error: errorMessage ?? "Payment not completed",
    },
    { status: 402 },
  );
}

function responseFromStoredState(reservation: OpenedPwaPurchase) {
  if (
    CAPTURED_PROVIDER_STATUSES.has(reservation.bound_payment_status ?? "") ||
    (
      reservation.last_result_kind === "captured" &&
      reservation.last_result_net_amount_cents === reservation.bound_amount_cents
    ) ||
    ["completed", "active", "trialing"].includes(reservation.bound_order_status)
  ) {
    return capturedResponse(
      reservation.solidgate_order_id,
      reservation.solidgate_subscription_id,
    );
  }

  // A cached ACS URL is reusable only while the durable provider state itself
  // still says 3ds_verify. `created`/`processing`/`auth_ok` can follow a
  // completed/expired challenge, so replaying their old URL would send the
  // buyer back to a stale ACS session.
  if (reservation.bound_payment_status === "3ds_verify") {
    const verifyUrl = safeVerifyUrl(reservation.verify_url);
    if (verifyUrl) {
      return NextResponse.json({
        ok: false,
        requiresAction: true,
        verifyUrl,
        orderId: reservation.solidgate_order_id,
      });
    }
  }

  if (
    reservation.purchase_mode === "hosted_form" &&
    reservation.merchant_data &&
    (reservation.bound_payment_status === null ||
      reservation.bound_payment_status === "creating")
  ) {
    return NextResponse.json({
      ok: false,
      needsCard: true,
      merchantData: reservation.merchant_data,
      orderId: reservation.solidgate_order_id,
    });
  }
  return pendingResponse(reservation.solidgate_order_id);
}

function productBindingMatches(
  providerProductId: string | undefined,
  expected: ExpectedBinding,
): boolean {
  return expected.productId === PWA_SUBSCRIPTION_PRODUCT
    ? providerProductId === expected.providerProductId
    : providerProductId == null;
}

function providerResultMatches(
  result: SolidgateChargeResult,
  orderId: string,
  customerAccountId: string,
  expected: ExpectedBinding,
  requireCaptured: boolean,
): boolean {
  if (
    result.orderId !== orderId ||
    result.providerOrderId !== orderId ||
    result.customerAccountId !== customerAccountId
  ) return false;
  if (
    result.orderAmount !== expected.amountCents ||
    result.currency?.toLowerCase() !== expected.currency ||
    !productBindingMatches(result.productId, expected)
  ) return false;
  if (expected.productId === PWA_SUBSCRIPTION_PRODUCT) {
    if (requireCaptured && !result.subscriptionId) return false;
  } else if (result.subscriptionId) {
    return false;
  }
  if (!requireCaptured) return true;
  return (
    result.providerStatus === "settle_ok" ||
    (
      result.providerStatus === "partial_settled" &&
      result.settledAmount === expected.amountCents
    )
  );
}

function terminalResultHasZeroNetEvidence(result: SolidgateChargeResult): boolean {
  return (
    result.verifyUrlConflict !== true &&
    result.subscriptionId == null &&
    (result.settledAmount == null || result.settledAmount === 0) &&
    result.verifyUrl == null
  );
}

function isDefiniteRequestRejection(
  result: SolidgateChargeResult,
  expectedOrderId: string,
): boolean {
  // `interpret()` emits this exact sparse shape only when Solidgate returned a
  // definite application error without creating a provider order. Any provider
  // identity, monetary, subscription, or challenge evidence is contradictory
  // and must keep the attempt from being retired.
  return (
    result.status === "failed" &&
    result.orderId === expectedOrderId &&
    result.providerStatus === "request_rejected" &&
    result.providerOrderId === undefined &&
    result.customerAccountId === undefined &&
    result.amount === undefined &&
    result.orderAmount === undefined &&
    result.settledAmount === undefined &&
    result.currency === undefined &&
    result.productId === undefined &&
    result.subscriptionId === undefined &&
    result.verifyUrl === undefined &&
    result.verifyUrlConflict !== true
  );
}

function terminalOrderHasZeroNetEvidence(
  order: ProviderOrder,
  verifyUrlInput: string | null | undefined,
): boolean {
  return (
    order.subscription_id == null &&
    (order.settled_amount == null || order.settled_amount === 0) &&
    verifyUrlInput == null
  );
}

function normalizedProviderOrder(
  status: ProviderStatus,
  expectedAmount: number,
): ProviderOrder | null {
  if (!status.order) return null;
  const capturedAmount = solidgateCapturedAmount(status, expectedAmount);
  return {
    ...status.order,
    ...(capturedAmount !== null && { settled_amount: capturedAmount }),
  };
}

function providerStatusProvesAbsence(status: ProviderStatus): boolean {
  if (status.order || !status.error || typeof status.error !== "object" || Array.isArray(status.error)) {
    return false;
  }
  const error = status.error as Record<string, unknown>;
  if (error.code !== "2.01" || !error.messages || typeof error.messages !== "object") {
    return false;
  }
  const orderMessages = (error.messages as Record<string, unknown>).order;
  return Array.isArray(orderMessages) && orderMessages.some(
    (message) => typeof message === "string" && message.trim().toLowerCase() === "order not found.",
  );
}

function providerOrderMatches(
  order: ProviderOrder,
  orderId: string,
  customerAccountId: string,
  expected: ExpectedBinding,
  requireCaptured: boolean,
): boolean {
  if (
    order.order_id !== orderId ||
    order.customer_account_id !== customerAccountId ||
    order.amount !== expected.amountCents ||
    order.currency?.toLowerCase() !== expected.currency ||
    !productBindingMatches(order.product_id, expected)
  ) return false;
  if (expected.productId === PWA_SUBSCRIPTION_PRODUCT) {
    if (requireCaptured && !order.subscription_id) return false;
  } else if (order.subscription_id) {
    return false;
  }
  if (!requireCaptured) return true;
  return (
    order.status === "settle_ok" ||
    (order.status === "partial_settled" && order.settled_amount === expected.amountCents)
  );
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json()) as {
      slug?: unknown;
      locale?: unknown;
      forceForm?: unknown;
    };
    const { slug } = body;

    if (typeof slug !== "string" || !PWA_SLUGS.has(slug as ProductId)) {
      return NextResponse.json({ error: "Unknown product" }, { status: 400 });
    }
    const productId = slug as ProductId;
    const productCode = PRODUCT_ID_TO_CODE[productId];

    const ssr = await createClient();
    const { data: auth } = await ssr.auth.getUser();
    const user = auth?.user;
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // The webhook binds the signed provider customer email back to this exact
    // authenticated account. Opening/submitting with a placeholder would make
    // every legitimate capture permanently unreconcilable, so reject before
    // the atomic opener or any provider call can create durable state.
    const supabase = getSupabaseAdminClient();
    const rpc = purchaseRpc(supabase);
    const { data: identityRows, error: identityError } = await rpc(
      "get_solidgate_pwa_checkout_identity",
      {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_product_slug: productCode,
      },
    );
    if (identityError) {
      console.error("[solidgate/purchase] checkout identity lookup failed:", identityError.message);
      return NextResponse.json({ error: "Unable to verify purchase identity" }, { status: 503 });
    }
    const identities = Array.isArray(identityRows) ? identityRows : [];
    if (identities.length > 1) {
      return NextResponse.json({ error: "Ambiguous purchase identity" }, { status: 500 });
    }
    const existingIdentity = identities[0] as {
      offer_slug?: unknown;
      customer_email?: unknown;
      checkout_locale?: unknown;
      amount_cents?: unknown;
      currency?: unknown;
      tracking_metadata?: unknown;
      purchase_mode?: unknown;
      solidgate_product_id?: unknown;
      solidgate_payment_action?: unknown;
    } | undefined;
    if (existingIdentity && existingIdentity.offer_slug !== productId) {
      return NextResponse.json({ error: "Existing purchase identity mismatch" }, { status: 409 });
    }

    const customerEmail = typeof existingIdentity?.customer_email === "string"
      ? normalizedAuthEmail(existingIdentity.customer_email)
      : normalizedAuthEmail(user.email);
    if (!customerEmail) {
      return NextResponse.json(
        { error: "A valid authenticated email is required for payment" },
        { status: 409 },
      );
    }

    let effectiveLocale: Locale;
    if (existingIdentity) {
      if (
        typeof existingIdentity.checkout_locale !== "string" ||
        !(routing.locales as readonly string[]).includes(existingIdentity.checkout_locale)
      ) {
        return NextResponse.json({ error: "Invalid bound purchase locale" }, { status: 500 });
      }
      effectiveLocale = existingIdentity.checkout_locale as Locale;
    } else {
      const { data: userPrefs, error: prefsError } = await supabase
        .from("user_prefs")
        .select("locale")
        .eq("user_id", user.id)
        .maybeSingle();
      if (prefsError) {
        return NextResponse.json({ error: "Failed to resolve billing locale" }, { status: 500 });
      }
      const storedLocale = userPrefs?.locale;
      effectiveLocale = (
        typeof storedLocale === "string" &&
        (routing.locales as readonly string[]).includes(storedLocale)
          ? storedLocale
          : routing.defaultLocale
      ) as Locale;
    }
    const currentPrice = resolveProductPrice(productId, effectiveLocale);
    const boundMetadata = existingIdentity?.tracking_metadata;
    if (
      existingIdentity &&
      (
        !Number.isSafeInteger(existingIdentity.amount_cents) ||
        (existingIdentity.amount_cents as number) < 0 ||
        typeof existingIdentity.currency !== "string" ||
        existingIdentity.currency !== existingIdentity.currency.toLowerCase() ||
        !boundMetadata ||
        typeof boundMetadata !== "object" ||
        Array.isArray(boundMetadata) ||
        (existingIdentity.purchase_mode !== "hosted_form" &&
          existingIdentity.purchase_mode !== "saved_card") ||
        existingIdentity.solidgate_payment_action !== "auth_settle"
      )
    ) {
      return NextResponse.json({ error: "Invalid bound purchase pricing" }, { status: 500 });
    }
    const amountCents = existingIdentity
      ? existingIdentity.amount_cents as number
      : currentPrice.amountCents;
    const currency = existingIdentity
      ? existingIdentity.currency as string
      : LOCALE_CURRENCY_MAP[effectiveLocale].toLowerCase();

    const catalogEntry = (catalogIds as CatalogIds)[
      productId === PWA_SUBSCRIPTION_PRODUCT ? PWA_SUBSCRIPTION_CATALOG_KEY : ""
    ];
    const priceId = productId === PWA_SUBSCRIPTION_PRODUCT
      ? existingIdentity
        ? typeof (boundMetadata as Record<string, unknown>).price_id === "string"
          ? (boundMetadata as Record<string, string>).price_id
          : null
        : catalogEntry?.prices[currency]
      : null;
    const solidgateProductId = existingIdentity
      ? typeof existingIdentity.solidgate_product_id === "string"
        ? existingIdentity.solidgate_product_id
        : null
      : productId === PWA_SUBSCRIPTION_PRODUCT
        ? catalogEntry?.product_id ?? null
        : null;
    if (
      productId === PWA_SUBSCRIPTION_PRODUCT &&
      (!priceId || (!existingIdentity && !catalogEntry?.product_id))
    ) {
      return NextResponse.json({ error: "Subscription product not seeded" }, { status: 500 });
    }
    if (
      (productId === PWA_SUBSCRIPTION_PRODUCT && !solidgateProductId) ||
      (productId !== PWA_SUBSCRIPTION_PRODUCT && solidgateProductId !== null)
    ) {
      return NextResponse.json({ error: "Invalid bound provider product" }, { status: 500 });
    }

    const { data: owned, error: ownedError } = await supabase
      .from("entitlements")
      .select("id")
      .eq("payment_environment", paymentEnvironment)
      .eq("user_id", user.id)
      .eq("product_slug", productCode)
      .is("revoked_at", null)
      .maybeSingle();
    if (ownedError) {
      return NextResponse.json({ error: "Failed to verify purchase ownership" }, { status: 500 });
    }
    if (owned) return NextResponse.json({ ok: true, alreadyOwned: true });

    const forwardedIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim();
    const ip = forwardedIp || (process.env.VERCEL_ENV === "production" ? null : "127.0.0.1");
    if (!ip) return NextResponse.json({ error: "Client IP is unavailable" }, { status: 400 });

    const keys = getSolidgateKeys();
    const client = new SolidgateClient(keys);
    const vault = await getAccountVault(supabase, user.id, paymentEnvironment);
    const savedPaymentType = paymentTypeForOriginalPaymentMethod(
      vault?.cardOriginalPaymentMethod,
    );
    const purchaseMode: PurchaseMode = existingIdentity
      ? existingIdentity.purchase_mode as PurchaseMode
      : vault?.cardToken && savedPaymentType && body.forceForm !== true
        ? "saved_card"
        : "hosted_form";
    // Both hosted-form and saved-card 3DS may leave the current page. Reject
    // before the atomic opener/provider when production has no trusted return
    // origin; otherwise a captured payment could have no exact-order recovery
    // path.
    if (!purchaseReturnUrl(request, effectiveLocale, "preflight")) {
      return NextResponse.json(
        { error: "Payment return URL is not configured" },
        { status: 500 },
      );
    }

    const { data: acquisition, error: acquisitionError } = await supabase
      .from("user_acquisition_attribution")
      .select("utm_source,utm_medium,utm_campaign,utm_content,utm_term")
      .eq("payment_environment", paymentEnvironment)
      .eq("user_id", user.id)
      .maybeSingle();
    if (acquisitionError) {
      console.error("[solidgate/purchase] acquisition lookup failed:", acquisitionError.message);
    }
    const accountRef = `u-${user.id}`;
    const orderMetadata = existingIdentity
      ? boundMetadata as Record<string, unknown>
      : {
          funnel_code: "PWA",
          funnel_variant: "member_area",
          session_id: accountRef,
          product_slug: productId,
          ...(priceId ? { price_id: priceId } : { locale: effectiveLocale }),
          ...normalizeAcquisitionUtm(acquisition),
        };

    const claimToken = crypto.randomUUID();
    const expected: ExpectedBinding = {
      paymentEnvironment,
      userId: user.id,
      accountRef,
      productId,
      productCode,
      amountCents,
      currency,
      locale: effectiveLocale,
      priceId,
      providerProductId: solidgateProductId,
      purchaseMode,
      claimToken,
      customerEmail,
      paymentAction: "auth_settle",
    };
    const openArgs = {
      p_payment_environment: paymentEnvironment,
      p_user_id: user.id,
      p_offer_slug: productId,
      p_product_slug: productCode,
      p_amount_cents: amountCents,
      p_currency: currency,
      p_tracking_metadata: orderMetadata,
      p_requested_mode: purchaseMode,
      p_claim_token: claimToken,
      p_customer_email: customerEmail,
      p_checkout_locale: effectiveLocale,
      p_solidgate_product_id: solidgateProductId,
      p_solidgate_payment_action: "auth_settle",
    };
    const loadReservation = async (): Promise<
      | { ok: true; reservation: OpenedPwaPurchase }
      | { ok: false; status: number; message: string }
    > => {
      const { data, error } = await rpc("open_solidgate_pwa_purchase_v2", openArgs);
      if (error) return { ok: false, status: 503, message: error.message };
      const reservation = asSingleReservation(data);
      if (!reservation) return { ok: false, status: 500, message: "unexpected RPC result" };
      const mismatch = reservationMismatch(reservation, expected);
      if (mismatch) return { ok: false, status: 500, message: `binding mismatch: ${mismatch}` };
      return { ok: true, reservation };
    };

    let loaded = await loadReservation();
    if (!loaded.ok) {
      console.error("[solidgate/purchase] atomic purchase open failed:", loaded.message);
      return NextResponse.json({ error: "Unable to open purchase safely" }, { status: loaded.status });
    }
    let reservation = loaded.reservation;

    if (reservation.purchase_mode === "hosted_form") {
      for (
        let poll = 0;
        !reservation.merchant_data && !reservation.should_build && poll < FORM_BUILD_POLL_ATTEMPTS;
        poll++
      ) {
        await wait(FORM_BUILD_POLL_MS);
        loaded = await loadReservation();
        if (!loaded.ok) {
          console.error("[solidgate/purchase] hosted form wait failed:", loaded.message);
          return NextResponse.json(
            { error: "Unable to resume purchase safely" },
            { status: loaded.status },
          );
        }
        reservation = loaded.reservation;
      }

      if (reservation.merchant_data || !reservation.should_build) {
        return responseFromStoredState(reservation);
      }

      const successUrl = purchaseReturnUrl(
        request,
        effectiveLocale,
        reservation.solidgate_order_id,
      );
      if (!successUrl) {
        return NextResponse.json(
          { error: "Payment return URL is not configured" },
          { status: 500 },
        );
      }

      const intent: SolidgatePaymentIntent = {
        order_id: reservation.solidgate_order_id,
        order_description: solidgateOrderDescription(
          effectiveLocale,
          productCode,
          SOLIDGATE_PRODUCT_CODES.main,
        ),
        dynamic_descriptor: solidgateDynamicDescriptor(productCode),
        amount: amountCents,
        currency: currency.toUpperCase(),
        // Shown in the Apple Pay sheet. Must match the merchant name registered
        // with Apple for this domain, or the sheet refuses to open.
        apple_pay_merchant_name: BOILERPLATE_BRAND.name,
        customer_account_id: user.id,
        customer_email: customerEmail,
        ip_address: ip,
        platform: "WEB",
        language: effectiveLocale,
        success_url: successUrl,
        order_metadata: reservation.bound_tracking_metadata,
      };
      if (productId === PWA_SUBSCRIPTION_PRODUCT) {
        intent.product_id = reservation.bound_solidgate_product_id as string;
        intent.product_price_id = priceId;
      }
      const merchantData = await buildFormMerchantData(keys.publicKey, keys.secretKey, intent);
      if (!isMerchantData(merchantData)) {
        return NextResponse.json({ error: "Failed to initialize purchase" }, { status: 500 });
      }
      const { data: finalized, error: finalizeError } = await rpc(
        "finalize_solidgate_pwa_form_v2",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_offer_slug: productId,
          p_product_slug: productCode,
          p_order_db_id: reservation.order_db_id,
          p_solidgate_order_id: reservation.solidgate_order_id,
          p_amount_cents: amountCents,
          p_currency: currency,
          p_claim_token: claimToken,
          p_merchant_data: merchantData,
          p_customer_email: reservation.bound_customer_email,
          p_checkout_locale: reservation.bound_checkout_locale,
        },
      );
      if (finalizeError || !isMerchantData(finalized)) {
        console.error("[solidgate/purchase] hosted form finalization failed:", finalizeError?.message);
        return NextResponse.json({ error: "Failed to initialize purchase safely" }, { status: 503 });
      }
      if (
        finalized.merchant !== merchantData.merchant ||
        finalized.paymentIntent !== merchantData.paymentIntent ||
        finalized.signature !== merchantData.signature
      ) {
        return NextResponse.json({ error: "Failed to initialize purchase safely" }, { status: 500 });
      }
      return NextResponse.json({
        ok: false,
        needsCard: true,
        merchantData: finalized,
        orderId: reservation.solidgate_order_id,
      });
    }

    if (!vault?.cardToken || !savedPaymentType) {
      return NextResponse.json({ error: "Saved payment method is unavailable" }, { status: 409 });
    }

    const recordResult = async (params: {
      resultKind: "pending" | "requires_action" | "captured" | "terminal_failure";
      providerStatus: string;
      netAmountCents: number;
      subscriptionId?: string | null;
      verifyUrl?: string | null;
    }): Promise<boolean> => {
      const { data, error } = await rpc("record_solidgate_pwa_submission_result", {
        p_payment_environment: paymentEnvironment,
        p_user_id: user.id,
        p_offer_slug: productId,
        p_product_slug: productCode,
        p_order_db_id: reservation.order_db_id,
        p_solidgate_order_id: reservation.solidgate_order_id,
        p_amount_cents: amountCents,
        p_currency: currency,
        p_claim_token: claimToken,
        p_result_kind: params.resultKind,
        p_provider_status: params.providerStatus,
        p_net_amount_cents: params.netAmountCents,
        p_subscription_id: params.subscriptionId ?? null,
        p_verify_url: params.verifyUrl ?? null,
      });
      if (error) {
        console.error("[solidgate/purchase] provider result persistence failed:", error.message);
        return false;
      }
      return data === true;
    };

    const handleObservedOrder = async (
      order: ProviderOrder,
      verifyUrlInput: string | null | undefined,
      verifyUrlConflict = false,
    ) => {
      const providerStatus = order.status;
      const decision = classifySolidgatePayment(order, amountCents);
      const requireCaptured = decision === "success";
      if (
        !providerStatus ||
        !providerOrderMatches(
          order,
          reservation.solidgate_order_id,
          vault.customerAccountId,
          expected,
          requireCaptured,
        )
      ) {
        console.error("[solidgate/purchase] reconciled provider binding mismatch", {
          orderId: reservation.solidgate_order_id,
        });
        return NextResponse.json(
          { error: "Provider order does not match this purchase", code: "binding_mismatch" },
          { status: 409 },
        );
      }

      if (decision === "success") {
        const persisted = await recordResult({
          resultKind: "captured",
          providerStatus,
          netAmountCents: amountCents,
          subscriptionId: order.subscription_id,
        });
        return persisted
          ? capturedResponse(reservation.solidgate_order_id, order.subscription_id ?? null)
          : pendingResponse(reservation.solidgate_order_id);
      }

      if (TERMINAL_PROVIDER_STATUSES.has(providerStatus)) {
        if (verifyUrlConflict || !terminalOrderHasZeroNetEvidence(order, verifyUrlInput)) {
          return NextResponse.json(
            { error: "Provider returned contradictory terminal payment evidence" },
            { status: 502 },
          );
        }
        const persisted = await recordResult({
          resultKind: "terminal_failure",
          providerStatus,
          netAmountCents: 0,
        });
        return persisted
          ? terminalResponse(reservation.solidgate_order_id, providerStatus)
          : pendingResponse(reservation.solidgate_order_id);
      }

      if (decision === "pending") {
        // A status lookup may only recover an ACS URL while Solidgate still
        // says the order is in 3DS. `created`/`processing` URLs are meaningful
        // only on the immediate recurring response, and `auth_ok` has already
        // left the challenge state. Never resurrect a stale redirect here.
        const verifyUrl = providerStatus === "3ds_verify" && !verifyUrlConflict
          ? safeVerifyUrl(verifyUrlInput) ?? safeVerifyUrl(reservation.verify_url)
          : null;
        const persisted = await recordResult({
          resultKind: verifyUrl ? "requires_action" : "pending",
          providerStatus,
          netAmountCents: amountCents,
          subscriptionId: order.subscription_id,
          verifyUrl,
        });
        if (!persisted) return pendingResponse(reservation.solidgate_order_id);
        if (verifyUrl) {
          return NextResponse.json({
            ok: false,
            requiresAction: true,
            verifyUrl,
            orderId: reservation.solidgate_order_id,
          });
        }
      }
      return pendingResponse(reservation.solidgate_order_id);
    };

    let shouldSubmit = reservation.should_submit;
    if (reservation.needs_reconcile) {
      let status: ProviderStatus;
      try {
        status = await client.status<ProviderStatus>({ order_id: reservation.solidgate_order_id });
      } catch {
        return pendingResponse(reservation.solidgate_order_id);
      }
      const observed = normalizedProviderOrder(status, amountCents);
      if (observed) {
        const verifyUrlResolution = resolveSolidgateVerifyUrl(status);
        return handleObservedOrder(
          observed,
          verifyUrlResolution.verifyUrl,
          verifyUrlResolution.conflict,
        );
      }
      if (!providerStatusProvesAbsence(status)) {
        return pendingResponse(reservation.solidgate_order_id);
      }

      const { data: resumed, error: resumeError } = await rpc(
        "resume_solidgate_pwa_submission_after_absent_reconcile",
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: user.id,
          p_offer_slug: productId,
          p_product_slug: productCode,
          p_order_db_id: reservation.order_db_id,
          p_solidgate_order_id: reservation.solidgate_order_id,
          p_amount_cents: amountCents,
          p_currency: currency,
          p_claim_token: claimToken,
        },
      );
      if (resumeError || resumed !== true) return pendingResponse(reservation.solidgate_order_id);
      shouldSubmit = true;
    } else if (!shouldSubmit) {
      return responseFromStoredState(reservation);
    }

    if (!shouldSubmit || reservation.claim_token !== claimToken) {
      return pendingResponse(reservation.solidgate_order_id);
    }

    const successUrl = purchaseReturnUrl(
      request,
      effectiveLocale,
      reservation.solidgate_order_id,
    );
    if (!successUrl) {
      return NextResponse.json({ error: "Payment return URL is not configured" }, { status: 500 });
    }
    const shared = {
      orderId: reservation.solidgate_order_id,
      recurringToken: vault.cardToken,
      paymentType: savedPaymentType,
      orderDescription: solidgateOrderDescription(
        effectiveLocale,
        productCode,
        SOLIDGATE_PRODUCT_CODES.main,
      ),
      customerAccountId: vault.customerAccountId,
      customerEmail,
      ipAddress: ip,
      // 3DS 2.0 browser data from the same-origin fetch — frictionless flow.
      headerAccept: request.headers.get("accept") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
      successUrl,
      metadata: reservation.bound_tracking_metadata as Record<string, string>,
      settlement: { attempts: 0 },
    };

    let result: SolidgateChargeResult;
    try {
      if (productId === PWA_SUBSCRIPTION_PRODUCT) {
        result = await subscribeSavedCard(client, {
          ...shared,
          productId: reservation.bound_solidgate_product_id as string,
          expectedAmount: amountCents,
          currency,
        });
      } else {
        result = await chargeSavedCard(client, {
          ...shared,
          amount: amountCents,
          currency,
        });
      }
    } catch (err) {
      // A transport failure cannot prove that Solidgate did not accept the
      // request. Preserve the submitter lease and canonical order identity so
      // an expired owner must reconcile this exact ID before any resubmission.
      console.error(
        "[solidgate/purchase] provider submission outcome is uncertain",
        err instanceof Error ? err.message : err,
      );
      return pendingResponse(reservation.solidgate_order_id);
    }

    if (result.status === "success") {
      if (
        !result.providerStatus ||
        !providerResultMatches(
          result,
          reservation.solidgate_order_id,
          vault.customerAccountId,
          expected,
          true,
        )
      ) {
        return NextResponse.json(
          { error: "Provider order does not match this purchase", code: "binding_mismatch" },
          { status: 409 },
        );
      }
      const persisted = await recordResult({
        resultKind: "captured",
        providerStatus: result.providerStatus,
        netAmountCents: amountCents,
        subscriptionId: result.subscriptionId,
      });
      return persisted
        ? capturedResponse(reservation.solidgate_order_id, result.subscriptionId ?? null)
        : pendingResponse(reservation.solidgate_order_id);
    }

    if (result.status === "requires_action") {
      const verifyUrl = safeVerifyUrl(result.verifyUrl);
      if (
        !verifyUrl ||
        !result.providerStatus ||
        !ACTIONABLE_PROVIDER_STATUSES.has(result.providerStatus) ||
        !providerResultMatches(
          result,
          reservation.solidgate_order_id,
          vault.customerAccountId,
          expected,
          false,
        )
      ) {
        return NextResponse.json(
          { error: "Provider returned an invalid payment challenge" },
          { status: 502 },
        );
      }
      const persisted = await recordResult({
        resultKind: "requires_action",
        providerStatus: result.providerStatus,
        netAmountCents: amountCents,
        subscriptionId: result.subscriptionId,
        verifyUrl,
      });
      return persisted
        ? NextResponse.json({
            ok: false,
            requiresAction: true,
            verifyUrl,
            orderId: reservation.solidgate_order_id,
          })
        : pendingResponse(reservation.solidgate_order_id);
    }

    if (result.status === "pending") {
      if (
        !result.providerStatus ||
        !providerResultMatches(
          result,
          reservation.solidgate_order_id,
          vault.customerAccountId,
          expected,
          false,
        )
      ) {
        return pendingResponse(reservation.solidgate_order_id);
      }
      await recordResult({
        resultKind: "pending",
        providerStatus: result.providerStatus,
        netAmountCents: amountCents,
        subscriptionId: result.subscriptionId,
      });
      return pendingResponse(reservation.solidgate_order_id);
    }

    const providerStatus = result.providerStatus;
    if (providerStatus === "request_rejected") {
      if (!isDefiniteRequestRejection(result, reservation.solidgate_order_id)) {
        return NextResponse.json(
          { error: "Provider returned contradictory rejected-request evidence" },
          { status: 502 },
        );
      }
      const persisted = await recordResult({
        resultKind: "terminal_failure",
        providerStatus,
        netAmountCents: 0,
      });
      return persisted
        ? terminalResponse(
            reservation.solidgate_order_id,
            providerStatus,
            result.errorCode,
            result.errorMessage,
          )
        : pendingResponse(reservation.solidgate_order_id);
    }

    if (providerStatus && TERMINAL_PROVIDER_STATUSES.has(providerStatus)) {
      if (!providerResultMatches(
        result,
        reservation.solidgate_order_id,
        vault.customerAccountId,
        expected,
        false,
      )) {
        return NextResponse.json(
          { error: "Provider order does not match this purchase", code: "binding_mismatch" },
          { status: 409 },
        );
      }
      if (!terminalResultHasZeroNetEvidence(result)) {
        return NextResponse.json(
          { error: "Provider returned contradictory terminal payment evidence" },
          { status: 502 },
        );
      }
      const persisted = await recordResult({
        resultKind: "terminal_failure",
        providerStatus,
        netAmountCents: 0,
      });
      return persisted
        ? terminalResponse(
            reservation.solidgate_order_id,
            providerStatus,
            result.errorCode,
            result.errorMessage,
          )
        : pendingResponse(reservation.solidgate_order_id);
    }

    // An error response with no provider order is not proof of terminality. Keep
    // the same identity leased; an expired owner must reconcile it before retry.
    return pendingResponse(reservation.solidgate_order_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[solidgate/purchase]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
