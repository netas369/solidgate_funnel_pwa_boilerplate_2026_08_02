import { after, NextResponse } from 'next/server';
import {
  signPaymentCookie,
  PAYMENT_COOKIE_NAME,
  PAYMENT_COOKIE_MAX_AGE,
} from '@repo/shared/payment-cookie';
import {
  signSolidgateMainAcceptedCookie,
  SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME,
  SOLIDGATE_MAIN_ACCEPTED_MAX_AGE,
} from '@repo/shared/solidgate/main-accepted-cookie';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { resolvePostLoginDestination } from '@repo/shared/auth/post-login-route';
import {
  buildSolidgateOrderId,
  SolidgateClient,
  getSolidgateKeys,
  introOfferEmailHash,
  introOfferConsumeGranted,
  introOfferConsumeNeedsRefund,
  parseSolidgateOrderId,
  paymentEnvironmentForVercel,
  solidgateDeclineReasonFromStatusError,
  solidgateGrantBlockReason,
  type IntroOfferConsumeResult,
  type PaymentEnvironment,
  type SolidgateDeclineReason,
} from '@repo/shared/solidgate';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import {
  getSessionVault,
  upsertSessionVault,
} from '@repo/shared/solidgate/session-vault';
import { promoteSessionVaultToAccount } from '@repo/shared/solidgate/account-vault';
import { drainSolidgateSubscriptionTokenSync } from '@repo/shared/solidgate/subscription-token-sync';
import { linkAuthUser } from '@/lib/payment/provision-account';
import {
  drainSolidgateFulfillmentOutbox,
  enqueueMainPurchaseEnrichment,
} from '@/lib/payment/solidgate-fulfillment';
import {
  MAIN_CHECKOUT_TIER_IDS,
  MAIN_CHECKOUT_TIER_SLUGS,
} from '@/lib/payment/checkout-tiers';
import { FUNNEL_CODE } from '@/features/analytics/lib/checkout-context';

/**
 * Server-side Solidgate payment grant.
 *
 * The form's `success` event is a claim made by the browser. Money is only
 * recognised here, after re-reading the order from Solidgate's status API with
 * our own keys. The client cannot name an order it does not own: order_id embeds the
 * session id, is server-generated inside an encrypted intent, and is checked
 * against the pending order row written before payment.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type MainCheckoutTier = (typeof MAIN_CHECKOUT_TIER_IDS)[number];
const INTRO_OFFER_TIERS = MAIN_CHECKOUT_TIER_SLUGS;
const MAIN_CHECKOUT_TIER_SET = MAIN_CHECKOUT_TIER_SLUGS;
const DURABLE_TERMINAL_PROVIDER_STATUSES = new Set(['auth_failed', 'declined', 'void_ok']);
const CARD_TERMINAL_PROVIDER_STATUSES = new Set(['auth_failed', 'declined', 'void_ok']);
const CAPTURED_PROVIDER_STATUSES = new Set(['settle_ok', 'partial_settled']);
const SOLIDGATE_ORIGINAL_PAYMENT_METHODS = [
  'card',
  'apple-pay',
  'google-pay',
  'network-token',
  'click-to-pay',
] as const;
type SolidgateOriginalPaymentMethod = (typeof SOLIDGATE_ORIGINAL_PAYMENT_METHODS)[number];
const SOLIDGATE_ORIGINAL_PAYMENT_METHOD_SET = new Set<string>(
  SOLIDGATE_ORIGINAL_PAYMENT_METHODS,
);
const REUSABLE_ORIGINAL_PAYMENT_METHOD_SET = new Set<SolidgateOriginalPaymentMethod>([
  'card',
  'apple-pay',
  'google-pay',
  'network-token',
]);
const ACQUISITION_UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

type SolidgateCardStatusTransaction = {
  id?: string;
  amount?: number;
  currency?: string;
  operation?: string;
  status?: string;
  card_token?: {
    token?: string;
    original_payment_method?: unknown;
  };
  card?: {
    brand?: string;
    number?: string;
    card_token?: {
      token?: string;
      original_payment_method?: unknown;
    };
  };
};

type NormalizedSolidgateCardStatusTransaction = SolidgateCardStatusTransaction & {
  id: string;
  resolvedCardToken: string | null;
  resolvedOriginalPaymentMethod: SolidgateOriginalPaymentMethod | null;
  resolvedCardBrand: string | null;
  resolvedCardNumber: string | null;
};

interface SolidgateOrderStatus {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    currency?: string;
    subscription_id?: string;
    customer_account_id?: string;
    customer_email?: string;
    product_id?: string;
    payment_method?: unknown;
  };
  transaction?: SolidgateCardStatusTransaction;
  transactions?: Record<string, SolidgateCardStatusTransaction>;
  error?: unknown;
}

const ORDER_GRANT_COLUMNS = 'id,session_id,user_id,psp,product_name,product_slug,amount_cents,currency,status,created_at,tracking_metadata,solidgate_subscription_id,solidgate_payment_status,solidgate_original_amount_cents,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,solidgate_checkout_identity_legacy' as const;

type BoundOrder = {
  id: string;
  session_id: string | null;
  user_id: string | null;
  psp: string;
  product_name: string | null;
  product_slug: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
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

type BoundMainPurchase = {
  orderDbId: string;
  sessionId: string;
  customerAccountId: string;
  tier: MainCheckoutTier;
  productCode: string;
  productId: string;
  productPriceId: string;
  amountCents: number;
  currency: string;
  paymentAction: 'auth_settle' | 'auth_0_amount';
  customerEmail: string;
  checkoutLocale: string;
};

function canonicalMainOrderBinding(
  orderId: string,
  sessionId: string,
  order: BoundOrder,
): BoundMainPurchase | null {
  const parsed = parseSolidgateOrderId(orderId);
  if (
    !parsed ||
    parsed.sessionId !== sessionId ||
    !Number.isSafeInteger(parsed.attempt) ||
    parsed.attempt > 999999999 ||
    !MAIN_CHECKOUT_TIER_SET.has(parsed.offeringSlug)
  ) return null;

  try {
    if (buildSolidgateOrderId(sessionId, parsed.offeringSlug, parsed.attempt) !== orderId) {
      return null;
    }
  } catch {
    return null;
  }

  const tier = parsed.offeringSlug as MainCheckoutTier;
  const currency = typeof order.currency === 'string' ? order.currency.toLowerCase() : '';
  const immutableGrossAmount = order.solidgate_original_amount_cents ?? order.amount_cents;
  const metadata = order.tracking_metadata;
  const expectedVariant = tier === 'special_1eur' || tier === 'special_free' ? tier : 'main';

  if (
    order.session_id !== sessionId ||
    order.psp !== 'solidgate' ||
    order.product_name !== SOLIDGATE_PRODUCT_CODES.main ||
    order.product_slug !== SOLIDGATE_PRODUCT_CODES.main ||
    order.solidgate_checkout_identity_legacy ||
    typeof order.solidgate_customer_email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.solidgate_customer_email) ||
    typeof order.solidgate_checkout_locale !== 'string' ||
    typeof order.solidgate_product_id !== 'string' ||
    !order.solidgate_product_id ||
    (order.solidgate_payment_action !== 'auth_settle' &&
      order.solidgate_payment_action !== 'auth_0_amount') ||
    order.currency !== currency ||
    !Number.isSafeInteger(immutableGrossAmount) ||
    immutableGrossAmount < 0 ||
    !/^[a-z]{3}$/.test(currency) ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) return null;

  const boundMetadata = metadata as Record<string, unknown>;
  const productPriceId = typeof boundMetadata.price_id === 'string'
    ? boundMetadata.price_id.trim()
    : '';
  if (
    boundMetadata.funnel_code !== FUNNEL_CODE ||
    boundMetadata.funnel_variant !== expectedVariant ||
    boundMetadata.session_id !== sessionId ||
    boundMetadata.product_slug !== tier ||
    !productPriceId
  ) return null;

  return {
    orderDbId: order.id,
    sessionId,
    customerAccountId: sessionId,
    tier,
    productCode: SOLIDGATE_PRODUCT_CODES.main,
    productId: order.solidgate_product_id,
    productPriceId,
    amountCents: immutableGrossAmount,
    currency,
    paymentAction: order.solidgate_payment_action,
    customerEmail: order.solidgate_customer_email,
    checkoutLocale: order.solidgate_checkout_locale,
  };
}

/**
 * Card pay/status may return the latest transaction both as `transaction` and
 * inside the `transactions` map. Collapse identical ids so partial capture is
 * never counted twice; malformed or conflicting duplicates are ambiguous and
 * therefore cannot prove payment.
 */
function optionalCardString(value: unknown): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeCardValue(
  left: string | null,
  right: string | null,
): { valid: boolean; value: string | null } {
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
    typeof value !== 'string'
    || !SOLIDGATE_ORIGINAL_PAYMENT_METHOD_SET.has(value)
  ) {
    return { valid: false, value: null };
  }
  return { valid: true, value: value as SolidgateOriginalPaymentMethod };
}

/**
 * `order.payment_method` is signed provider context for the checkout channel.
 * The `token` value describes a later token charge, not the token's immutable
 * origin, so it cannot be used as provenance fallback.
 */
function optionalOrderPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value === 'token') return { valid: true, value: null };
  return optionalOriginalPaymentMethod(value);
}

function isOperationAlignedReusableCredential(
  operation: string | undefined,
  originalPaymentMethod: SolidgateOriginalPaymentMethod | null,
): boolean {
  if (operation === 'auth') {
    return originalPaymentMethod === 'card' || originalPaymentMethod === 'network-token';
  }
  if (operation === 'apple-pay') return originalPaymentMethod === 'apple-pay';
  if (operation === 'google-pay') return originalPaymentMethod === 'google-pay';
  return false;
}

function normalizedCardDetails(
  transaction: SolidgateCardStatusTransaction,
  orderPaymentMethod: SolidgateOriginalPaymentMethod | null,
): {
  valid: boolean;
  token: string | null;
  originalPaymentMethod: SolidgateOriginalPaymentMethod | null;
  brand: string | null;
  number: string | null;
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
      originalPaymentMethod: null,
      brand: null,
      number: null,
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
  const credentialComplete = token.value !== null && originalPaymentMethod.value !== null;
  return {
    valid: token.valid && originalPaymentMethod.valid,
    // Prefer token-level immutable provenance. Current Solidgate Payment Form
    // status responses can omit it, so the signed order.payment_method is the
    // only accepted fallback. Browser-selected wallet/card state is never
    // authoritative evidence, and conflicting provider fields fail closed.
    token: credentialComplete ? token.value : null,
    originalPaymentMethod: originalPaymentMethod.valid
      ? originalPaymentMethod.value as SolidgateOriginalPaymentMethod | null
      : null,
    brand: brand.value,
    number: number.value,
  };
}

function cardStatusTransactions(
  status: SolidgateOrderStatus,
): NormalizedSolidgateCardStatusTransaction[] | null {
  const orderPaymentMethod = optionalOrderPaymentMethod(status.order?.payment_method);
  if (!orderPaymentMethod.valid) return null;
  const byId = new Map<string, NormalizedSolidgateCardStatusTransaction>();
  const add = (transaction: SolidgateCardStatusTransaction, mapId?: string): boolean => {
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
        resolvedOriginalPaymentMethod: details.originalPaymentMethod,
        resolvedCardBrand: details.brand,
        resolvedCardNumber: details.number,
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
    const originalPaymentMethod = mergeCardValue(
      existing.resolvedOriginalPaymentMethod,
      details.originalPaymentMethod,
    );
    const brand = mergeCardValue(existing.resolvedCardBrand, details.brand);
    const number = mergeCardValue(existing.resolvedCardNumber, details.number);
    if (!token.valid || !originalPaymentMethod.valid || !brand.valid || !number.valid) return false;
    byId.set(id, {
      ...existing,
      resolvedCardToken: token.value,
      resolvedOriginalPaymentMethod:
        originalPaymentMethod.value as SolidgateOriginalPaymentMethod | null,
      resolvedCardBrand: brand.value,
      resolvedCardNumber: number.value,
    });
    return true;
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function vaultableMainCardAuthorization(
  status: SolidgateOrderStatus,
  purchase: BoundMainPurchase,
): NormalizedSolidgateCardStatusTransaction | null {
  const transactions = cardStatusTransactions(status);
  if (!transactions) return null;
  const candidates = transactions.filter((transaction) => (
    transaction.status === 'success' &&
    isOperationAlignedReusableCredential(
      transaction.operation,
      transaction.resolvedOriginalPaymentMethod,
    ) &&
    transaction.amount === purchase.amountCents &&
    transaction.currency?.toLowerCase() === purchase.currency &&
    transaction.resolvedCardToken !== null
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Settlement proof is independent from reusable-token provenance. A malformed
 * wallet/card token must only disable vaulting; it cannot erase an otherwise
 * exact capture returned by Solidgate.
 */
function financialSettlementTransactions(
  status: SolidgateOrderStatus,
): SolidgateCardStatusTransaction[] | null {
  const byId = new Map<string, SolidgateCardStatusTransaction>();
  const add = (transaction: SolidgateCardStatusTransaction, mapId?: string): boolean => {
    if (transaction.operation !== 'settle') return true;
    const parsedId = optionalCardString(transaction.id);
    const id = parsedId.valid ? parsedId.value : null;
    if (!id || (mapId != null && mapId !== id)) return false;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...transaction, id });
      return true;
    }
    return (
      existing.amount === transaction.amount
      && existing.currency === transaction.currency
      && existing.operation === transaction.operation
      && existing.status === transaction.status
    );
  };

  if (status.transaction && !add(status.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(status.transactions ?? {})) {
    if (!transaction || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function hasExactPartialCapture(
  status: SolidgateOrderStatus,
  amountCents: number,
  currency: string,
): boolean {
  const transactions = financialSettlementTransactions(status);
  if (!transactions) return false;
  let captured = 0;
  let foundSettlement = false;
  for (const transaction of transactions) {
    if (transaction.operation !== 'settle' || transaction.status !== 'success') continue;
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

function sameMainBinding(left: BoundMainPurchase, right: BoundMainPurchase): boolean {
  return (
    left.orderDbId === right.orderDbId &&
    left.sessionId === right.sessionId &&
    left.customerAccountId === right.customerAccountId &&
    left.tier === right.tier &&
    left.productCode === right.productCode &&
    left.productId === right.productId &&
    left.productPriceId === right.productPriceId &&
    left.amountCents === right.amountCents &&
    left.currency === right.currency &&
    left.paymentAction === right.paymentAction &&
    left.customerEmail === right.customerEmail &&
    left.checkoutLocale === right.checkoutLocale
  );
}

function providerMainOrderMatches(
  providerOrder: SolidgateOrderStatus['order'],
  orderId: string,
  purchase: BoundMainPurchase,
): boolean {
  if (
    !providerOrder ||
    providerOrder.order_id !== orderId ||
    providerOrder.amount !== purchase.amountCents ||
    providerOrder.currency?.toLowerCase() !== purchase.currency ||
    providerOrder.customer_account_id !== purchase.customerAccountId ||
    (
      typeof providerOrder.customer_email === 'string' &&
      providerOrder.customer_email.trim().toLowerCase() !== purchase.customerEmail
    ) ||
    providerOrder.product_id !== purchase.productId
  ) return false;

  const status = providerOrder.status;
  const subscriptionId = providerOrder.subscription_id;
  const hasSubscription = typeof subscriptionId === 'string' && subscriptionId.length > 0;

  if (status === 'auth_ok') {
    if (!hasSubscription) return false;
    // Free auth is the terminal success of auth_0_amount. Paid auth_settle also
    // passes through auth_ok, but remains pending until an exact capture lands.
    return purchase.paymentAction === 'auth_0_amount'
      ? purchase.amountCents === 0
      : purchase.amountCents > 0;
  }
  if (status && CAPTURED_PROVIDER_STATUSES.has(status)) {
    return (
      purchase.paymentAction === 'auth_settle' &&
      hasSubscription
    );
  }
  return true;
}

function mainPaymentDecision(
  status: SolidgateOrderStatus,
  purchase: BoundMainPurchase,
): 'success' | 'pending' | 'terminal' | 'reversed' {
  const providerStatus = status.order?.status;
  if (providerStatus === 'settle_ok') return 'success';
  if (providerStatus === 'partial_settled') {
    return hasExactPartialCapture(status, purchase.amountCents, purchase.currency)
      ? 'success'
      : 'pending';
  }
  if (
    providerStatus === 'auth_ok' &&
    purchase.paymentAction === 'auth_0_amount' &&
    purchase.amountCents === 0
  ) return 'success';
  if (providerStatus === 'refunded') return 'reversed';
  if (providerStatus && CARD_TERMINAL_PROVIDER_STATUSES.has(providerStatus)) return 'terminal';
  return 'pending';
}

function invalidMainBindingResponse() {
  return NextResponse.json(
    { error: 'Order is not a valid main checkout', code: 'invalid_purchase_binding' },
    { status: 403 },
  );
}

function providerMismatchResponse() {
  return NextResponse.json(
    { error: 'Payment does not match the opened checkout', code: 'payment_mismatch' },
    { status: 409 },
  );
}

function localBindingChangedResponse() {
  return NextResponse.json(
    { error: 'Checkout binding changed while payment was being verified', code: 'local_binding_changed' },
    { status: 409 },
  );
}

function clearMainAcceptedCookie(response: NextResponse) {
  response.cookies.set(SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}

// The accepted handoff now mints the payment cookie at auth_ok, so a terminal
// decline must take it back — every cookie consumer (proxy OTO gate,
// claim-purchase, session reads) was built on "payment cookie ⇒ verified
// money", and a post-auth decline would otherwise leave a failed payment
// holding that authority for the cookie's full lifetime.
function clearPaymentAccessCookie(response: NextResponse) {
  response.cookies.set(PAYMENT_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}

function terminalFailureResponse(
  orderId: string,
  providerStatus: string,
  declineReason: SolidgateDeclineReason | null = null,
) {
  return clearPaymentAccessCookie(clearMainAcceptedCookie(NextResponse.json(
    {
      ok: false,
      terminal: true,
      retryable: true,
      orderId,
      status: providerStatus,
      code: providerStatus === 'void_ok' ? 'void_ok' : 'payment_failed',
      // Normalized gateway decline family (never the raw code); the checkout
      // maps it to localized copy so the buyer learns WHY the card declined.
      ...(providerStatus !== 'void_ok' && declineReason ? { declineReason } : {}),
      error: providerStatus === 'void_ok'
        ? 'Payment authorization was voided'
        : 'Payment not completed',
    },
    { status: 402 },
  )));
}

function trackingUtm(value: unknown): Partial<Record<(typeof ACQUISITION_UTM_KEYS)[number], string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Partial<Record<(typeof ACQUISITION_UTM_KEYS)[number], string>> = {};
  for (const key of ACQUISITION_UTM_KEYS) {
    const candidate = source[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      result[key] = candidate.trim().slice(0, 380);
    }
  }
  return result;
}

async function replayBlockReason(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  order: BoundOrder,
) {
  const { data: entitlement, error } = await supabase
    .from('entitlements')
    .select('status,revoked_at')
    .eq('payment_environment', paymentEnvironment)
    .eq('order_id', order.id)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify entitlement state: ${error.message}`);
  return solidgateGrantBlockReason(order, entitlement);
}

async function specialFreeCardReady(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  orderDbId: string,
): Promise<boolean> {
  type SpecialFreeCardReadyRpc = (
    fn: 'solidgate_special_free_card_ready',
    args: { p_order_id: string },
  ) => PromiseLike<{ data: boolean | null; error: { message: string } | null }>;
  const rpc = supabase.rpc.bind(supabase) as unknown as SpecialFreeCardReadyRpc;
  const { data, error } = await rpc('solidgate_special_free_card_ready', {
    p_order_id: orderDbId,
  });
  if (error) {
    throw new Error(`Failed to verify special_free reusable card: ${error.message}`);
  }
  return data === true;
}

/**
 * A signed webhook can persist the exact special_free card before the browser
 * polls pay/status, then fail either before or after granting entitlement.
 * Solidgate may subsequently return only the order object, omitting the
 * authorization transaction which carried the reusable token. In that race,
 * resume only from exact durable local proof.
 *
 * This is intentionally not a generic "saved card exists" fallback. The
 * database helper accepts only the exact order source or a strictly newer,
 * canonical captured main source. If entitlement already exists, it must
 * still match this order, user, product and subscription exactly.
 */
async function durableSpecialFreeCardToken(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  params: {
    paymentEnvironment: PaymentEnvironment;
    order: BoundOrder;
    purchase: BoundMainPurchase;
    subscriptionId: string | null;
  },
): Promise<string | null> {
  const { paymentEnvironment, order, purchase, subscriptionId } = params;
  if (
    purchase.tier !== 'special_free' ||
    !subscriptionId ||
    !['trialing', 'active'].includes(order.status) ||
    order.amount_cents !== 0 ||
    order.solidgate_original_amount_cents !== 0 ||
    order.solidgate_payment_status !== 'auth_ok' ||
    order.solidgate_subscription_id !== subscriptionId
  ) return null;

  const vault = await getSessionVault(supabase, purchase.sessionId, paymentEnvironment);
  const cardToken = typeof vault?.cardToken === 'string' ? vault.cardToken.trim() : '';
  const originalPaymentMethod = vault?.cardOriginalPaymentMethod;
  if (
    !vault ||
    vault.paymentEnvironment !== paymentEnvironment ||
    vault.sessionId !== purchase.sessionId ||
    vault.customerAccountId !== purchase.customerAccountId ||
    !vault.sourceOrderId ||
    !cardToken ||
    typeof originalPaymentMethod !== 'string' ||
    !REUSABLE_ORIGINAL_PAYMENT_METHOD_SET.has(
      originalPaymentMethod as SolidgateOriginalPaymentMethod,
    )
  ) return null;
  if (!await specialFreeCardReady(supabase, purchase.orderDbId)) return null;

  const { data: entitlement, error } = await supabase
    .from('entitlements')
    .select('user_id,product_slug,access_level,status,order_id,solidgate_subscription_id,revoked_at')
    .eq('payment_environment', paymentEnvironment)
    .eq('order_id', purchase.orderDbId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to verify special_free entitlement state: ${error.message}`);
  }
  // No entitlement means an earlier signed webhook may have failed after the
  // card vault landed but before account/access work. The DB card-ready proof
  // is sufficient to resume that idempotent work. If an entitlement already
  // exists, accept only the exact durable winner; never repair through a
  // conflicting or revoked row.
  if (entitlement && (
    !order.user_id ||
    entitlement.user_id !== order.user_id ||
    entitlement.product_slug !== purchase.productCode ||
    entitlement.access_level !== 'full' ||
    entitlement.status !== 'active' ||
    entitlement.order_id !== purchase.orderDbId ||
    entitlement.solidgate_subscription_id !== subscriptionId ||
    entitlement.revoked_at != null
  )) return null;

  return cardToken;
}

function replayBlockedResponse() {
  return clearMainAcceptedCookie(NextResponse.json(
    { error: 'Purchase is no longer grantable', code: 'grant_revoked' },
    { status: 409 },
  ));
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json()) as { orderId?: unknown; sessionId?: unknown };
    const { orderId, sessionId } = body;

    if (typeof orderId !== 'string' || !orderId) {
      return NextResponse.json({ error: 'Missing orderId' }, { status: 400 });
    }
    if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId format' }, { status: 400 });
    }

    // The order_id itself carries the session it belongs to.
    const parsed = parseSolidgateOrderId(orderId);
    if (!parsed || parsed.sessionId !== sessionId) {
      return NextResponse.json(
        { error: 'Order does not belong to this session' },
        { status: 403 },
      );
    }

    const supabase = getSupabaseAdminClient();

    // …and the pending row written before payment proves we opened it.
    const { data: pendingRawOrder, error: pendingError } = await supabase
      .from('orders')
      .select(ORDER_GRANT_COLUMNS)
      .eq('payment_environment', paymentEnvironment)
      .eq('solidgate_order_id', orderId)
      .maybeSingle();
    if (pendingError) {
      return NextResponse.json({ error: 'Failed to verify payment ownership' }, { status: 500 });
    }
    const pendingOrder = pendingRawOrder as BoundOrder | null;
    if (!pendingOrder || pendingOrder.session_id !== sessionId) {
      return NextResponse.json(
        { error: 'Order does not belong to this session' },
        { status: 403 },
      );
    }
    const pendingPurchase = canonicalMainOrderBinding(orderId, sessionId, pendingOrder);
    if (!pendingPurchase) return invalidMainBindingResponse();

    // A webhook may win the race with the SDK fail callback. Its persisted,
    // signature-verified terminal status is sufficient to let the client ask
    // create-session for N+1; it must never re-open from a generic 409/500.
    if (
      pendingOrder.status === 'failed' &&
      pendingOrder.solidgate_payment_status &&
      DURABLE_TERMINAL_PROVIDER_STATUSES.has(pendingOrder.solidgate_payment_status)
    ) {
      return terminalFailureResponse(orderId, pendingOrder.solidgate_payment_status);
    }
    const initialBlock = await replayBlockReason(supabase, paymentEnvironment, pendingOrder);
    if (initialBlock) {
      console.warn('[solidgate/grant] blocked replay', { orderId, reason: initialBlock });
      return replayBlockedResponse();
    }

    // Server-side truth.
    const client = new SolidgateClient(getSolidgateKeys());
    const status = await client.status<SolidgateOrderStatus>({ order_id: orderId });
    const order = status.order;
    if (!order) {
      return NextResponse.json(
        { ok: false, pending: true, status: null },
        { status: 202 },
      );
    }
    if (!providerMainOrderMatches(order, orderId, pendingPurchase)) {
      console.error('[solidgate/grant] provider binding mismatch', { orderId });
      return providerMismatchResponse();
    }
    const paymentDecision = mainPaymentDecision(status, pendingPurchase);
    // Exactly one provider read per request. The browser owns the bounded retry
    // cadence; nested server sleeps multiply latency and request volume without
    // adding any payment truth.
    if (paymentDecision !== 'success') {
      const providerStatus = order.status;
      if (paymentDecision === 'reversed') return replayBlockedResponse();
      const acceptedAuthorization =
        paymentDecision === 'pending' &&
        providerStatus === 'auth_ok' &&
        pendingPurchase.paymentAction === 'auth_settle' &&
        pendingPurchase.amountCents > 0 &&
        typeof order.subscription_id === 'string' &&
        order.subscription_id.length > 0 &&
        vaultableMainCardAuthorization(status, pendingPurchase) !== null;

      if (acceptedAuthorization) {
        // `auth_ok` is a provider-confirmed reservation, not captured revenue.
        // Persist the immutable reservation evidence so a webhook or the next
        // exact-order poll can advance it monotonically, and publish the
        // reusable card credential so OTO1 can charge one-click while the
        // immediate capture (settle_interval 0) completes in the background.
        // Everything that recognises revenue still waits for the captured
        // status: do not consume the intro claim, grant entitlement, provision
        // an account, or emit purchase enrichment here.
        let reservationWriter = supabase
          .from('orders')
          .update({
            solidgate_payment_status: 'auth_ok',
            solidgate_subscription_id: order.subscription_id,
            solidgate_original_amount_cents: pendingPurchase.amountCents,
          })
          .eq('payment_environment', paymentEnvironment)
          .eq('solidgate_order_id', orderId)
          .eq('id', pendingPurchase.orderDbId)
          .eq('session_id', pendingPurchase.sessionId)
          .eq('psp', 'solidgate')
          .eq('product_name', pendingPurchase.productCode)
          .eq('product_slug', pendingPurchase.productCode)
          .eq('amount_cents', pendingOrder.amount_cents)
          .eq('currency', pendingPurchase.currency)
          .eq('solidgate_refunded_amount_cents', pendingOrder.solidgate_refunded_amount_cents)
          .eq('solidgate_chargeback_amount_cents', pendingOrder.solidgate_chargeback_amount_cents)
          .eq('status', 'pending');
        reservationWriter = pendingOrder.solidgate_payment_status == null
          ? reservationWriter.is('solidgate_payment_status', null)
          : reservationWriter.eq('solidgate_payment_status', pendingOrder.solidgate_payment_status);
        reservationWriter = pendingOrder.solidgate_original_amount_cents == null
          ? reservationWriter.is('solidgate_original_amount_cents', null)
          : reservationWriter.eq(
              'solidgate_original_amount_cents',
              pendingOrder.solidgate_original_amount_cents,
            );
        reservationWriter = pendingOrder.solidgate_subscription_id == null
          ? reservationWriter.is('solidgate_subscription_id', null)
          : reservationWriter.eq(
              'solidgate_subscription_id',
              pendingOrder.solidgate_subscription_id,
            );
        reservationWriter = pendingOrder.solidgate_chargeback_id == null
          ? reservationWriter.is('solidgate_chargeback_id', null)
          : reservationWriter.eq('solidgate_chargeback_id', pendingOrder.solidgate_chargeback_id);
        reservationWriter = pendingOrder.solidgate_chargeback_status == null
          ? reservationWriter.is('solidgate_chargeback_status', null)
          : reservationWriter.eq(
              'solidgate_chargeback_status',
              pendingOrder.solidgate_chargeback_status,
            );
        const { data: reservedOrder, error: reservationError } = await reservationWriter
          .select('id')
          .maybeSingle();
        if (reservationError) {
          console.error('[solidgate/grant] authorization reservation failed:', reservationError.message);
          return NextResponse.json({ error: 'Failed to record payment authorization' }, { status: 500 });
        }

        if (!reservedOrder?.id) {
          // A signed webhook or another browser poll may have won this CAS.
          const { data: racedRawOrder, error: racedError } = await supabase
            .from('orders')
            .select(ORDER_GRANT_COLUMNS)
            .eq('payment_environment', paymentEnvironment)
            .eq('solidgate_order_id', orderId)
            .maybeSingle();
          if (racedError) {
            return NextResponse.json({ error: 'Failed to verify payment authorization' }, { status: 500 });
          }
          const racedOrder = racedRawOrder as BoundOrder | null;
          const racedBinding = racedOrder
            ? canonicalMainOrderBinding(orderId, sessionId, racedOrder)
            : null;
          const racedBlock = racedOrder
            ? await replayBlockReason(supabase, paymentEnvironment, racedOrder)
            : 'order_status';
          if (
            !racedOrder ||
            !racedBinding ||
            !sameMainBinding(pendingPurchase, racedBinding) ||
            racedBlock
          ) return replayBlockedResponse();
          if (
            racedOrder.status !== 'pending' ||
            racedOrder.solidgate_payment_status !== 'auth_ok' ||
            racedOrder.solidgate_subscription_id !== order.subscription_id ||
            racedOrder.solidgate_original_amount_cents !== pendingPurchase.amountCents
          ) {
            // A same-binding, non-blocked winner that is NOT the identical
            // reservation: the webhook's bare auth_ok write (payment status
            // only), its settle finalizer, or a terminal write landed inside
            // our read→CAS window. None of that is a failure of THIS payment —
            // answer pending and let the next poll re-read the fresh row and
            // take the ordinary accepted/success/terminal path. The old fatal
            // 409 here showed a decline to buyers whose capture had just
            // SUCCEEDED.
            return NextResponse.json(
              {
                ok: false,
                pending: true,
                orderId,
                status: racedOrder.solidgate_payment_status ?? null,
              },
              { status: 202 },
            );
          }
          // Identical reservation persisted by the racing writer: fall through
          // to the normal accepted response (vault + cookies) below.
        }

        // The verified authorization already carries the reusable credential
        // (acceptedAuthorization required it), so hand it to the session vault
        // now. Best effort: the settle path re-publishes the identical source,
        // and OTO1's pm-info retry loop absorbs a transient gap.
        const acceptedTransaction = vaultableMainCardAuthorization(status, pendingPurchase);
        if (acceptedTransaction) {
          try {
            await upsertSessionVault(supabase, {
              sessionId,
              sourceOrderId: pendingPurchase.orderDbId,
              customerAccountId: pendingPurchase.customerAccountId,
              card: {
                token: acceptedTransaction.resolvedCardToken,
                originalPaymentMethod: acceptedTransaction.resolvedOriginalPaymentMethod,
                brand: acceptedTransaction.resolvedCardBrand,
                maskedNumber: acceptedTransaction.resolvedCardNumber,
              },
            });
          } catch (vaultError) {
            console.error(
              '[solidgate/grant] auth_ok vault publish failed:',
              vaultError instanceof Error ? vaultError.message : vaultError,
            );
          }
        }

        const signedAccepted = await signSolidgateMainAcceptedCookie({
          orderId,
          sessionId,
          paymentEnvironment,
        });
        // The OTO chain's session access is gated on this cookie. Issuing it on
        // the authorization is what lets pm-info/charge-oto run before capture;
        // solidgate-access still re-verifies the source order's financial state
        // on every use, so a later void/decline closes the gate server-side.
        const signedPayment = await signPaymentCookie(orderId, sessionId);
        const resumeTo = `/oto/1?sg_main=${encodeURIComponent(orderId)}`;
        const response = NextResponse.json(
          {
            ok: false,
            pending: true,
            accepted: true,
            authorized: true,
            orderId,
            status: 'auth_ok',
            resumeTo,
            subscriptionId: order.subscription_id,
          },
          { status: 202 },
        );
        response.cookies.set(SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME, signedAccepted, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: SOLIDGATE_MAIN_ACCEPTED_MAX_AGE,
          path: '/',
        });
        response.cookies.set(PAYMENT_COOKIE_NAME, signedPayment, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: PAYMENT_COOKIE_MAX_AGE,
          path: '/',
        });
        return response;
      }
      if (paymentDecision !== 'terminal' || !providerStatus) {
        return NextResponse.json(
          { ok: false, pending: true, status: providerStatus ?? null },
          { status: 202 },
        );
      }

      let failureUpdate = supabase
        .from('orders')
        .update({
          status: 'failed',
          solidgate_payment_status: providerStatus,
          solidgate_original_amount_cents: pendingPurchase.amountCents,
        })
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .eq('id', pendingPurchase.orderDbId)
        .eq('session_id', pendingPurchase.sessionId)
        .eq('psp', 'solidgate')
        .eq('product_name', pendingPurchase.productCode)
        .eq('product_slug', pendingPurchase.productCode)
        .eq('amount_cents', pendingOrder.amount_cents)
        .eq('currency', pendingPurchase.currency)
        .eq('solidgate_refunded_amount_cents', pendingOrder.solidgate_refunded_amount_cents)
        .eq('solidgate_chargeback_amount_cents', pendingOrder.solidgate_chargeback_amount_cents)
        .eq('status', 'pending');
      failureUpdate = pendingOrder.solidgate_payment_status == null
        ? failureUpdate.is('solidgate_payment_status', null)
        : failureUpdate.eq('solidgate_payment_status', pendingOrder.solidgate_payment_status);
      failureUpdate = pendingOrder.solidgate_original_amount_cents == null
        ? failureUpdate.is('solidgate_original_amount_cents', null)
        : failureUpdate.eq(
            'solidgate_original_amount_cents',
            pendingOrder.solidgate_original_amount_cents,
          );
      failureUpdate = pendingOrder.solidgate_subscription_id == null
        ? failureUpdate.is('solidgate_subscription_id', null)
        : failureUpdate.eq('solidgate_subscription_id', pendingOrder.solidgate_subscription_id);
      failureUpdate = pendingOrder.solidgate_chargeback_id == null
        ? failureUpdate.is('solidgate_chargeback_id', null)
        : failureUpdate.eq('solidgate_chargeback_id', pendingOrder.solidgate_chargeback_id);
      failureUpdate = pendingOrder.solidgate_chargeback_status == null
        ? failureUpdate.is('solidgate_chargeback_status', null)
        : failureUpdate.eq('solidgate_chargeback_status', pendingOrder.solidgate_chargeback_status);
      const { data: failedOrder, error: failureUpdateError } = await failureUpdate
        .select('id')
        .maybeSingle();
      if (failureUpdateError) {
        return NextResponse.json({ error: 'Failed to record terminal payment' }, { status: 500 });
      }
      if (failedOrder?.id) {
        return terminalFailureResponse(
          orderId,
          providerStatus,
          solidgateDeclineReasonFromStatusError(status.error),
        );
      }

      // A terminal webhook may have performed the identical transition between
      // the provider read and our CAS. Confirm that exact durable result; any
      // other zero-row outcome stays blocked on the original order.
      const { data: racedRawOrder, error: racedOrderError } = await supabase
        .from('orders')
        .select(ORDER_GRANT_COLUMNS)
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (racedOrderError) {
        return NextResponse.json({ error: 'Failed to verify terminal payment' }, { status: 500 });
      }
      const racedOrder = racedRawOrder as BoundOrder | null;
      const racedBinding = racedOrder
        ? canonicalMainOrderBinding(orderId, sessionId, racedOrder)
        : null;
      if (
        racedOrder?.status === 'failed' &&
        racedOrder.solidgate_payment_status === providerStatus &&
        racedBinding &&
        sameMainBinding(pendingPurchase, racedBinding)
      ) {
        return terminalFailureResponse(
          orderId,
          providerStatus,
          solidgateDeclineReasonFromStatusError(status.error),
        );
      }
      return replayBlockedResponse();
    }

    // Local refund/cancellation/dispute state wins over an old provider
    // `settle_ok`. It may have changed while status polling was in flight.
    const { data: freshRawOrder, error: freshOrderError } = await supabase
      .from('orders')
      .select(ORDER_GRANT_COLUMNS)
      .eq('payment_environment', paymentEnvironment)
      .eq('solidgate_order_id', orderId)
      .maybeSingle();
    if (freshOrderError) {
      return NextResponse.json({ error: 'Failed to verify payment state' }, { status: 500 });
    }
    const freshOrder = freshRawOrder as BoundOrder | null;
    if (!freshOrder || freshOrder.session_id !== sessionId) return replayBlockedResponse();
    const freshPurchase = canonicalMainOrderBinding(orderId, sessionId, freshOrder);
    if (!freshPurchase) return invalidMainBindingResponse();
    if (!sameMainBinding(pendingPurchase, freshPurchase)) {
      console.error('[solidgate/grant] local binding changed during confirmation', { orderId });
      return localBindingChangedResponse();
    }
    const freshBlock = await replayBlockReason(supabase, paymentEnvironment, freshOrder);
    if (freshBlock) {
      console.warn('[solidgate/grant] blocked replay', { orderId, reason: freshBlock });
      return replayBlockedResponse();
    }

    const subscriptionId = order.subscription_id ?? null;
    const authorizedTrial =
      order.status === 'auth_ok' &&
      freshPurchase.amountCents === 0 &&
      order.amount === 0 &&
      Boolean(subscriptionId);
    const captured = Boolean(order.status && CAPTURED_PROVIDER_STATUSES.has(order.status));
    const settled = captured;
    const fullyCaptured = order.status === 'partial_settled';
    const transaction = vaultableMainCardAuthorization(status, freshPurchase);
    let cardToken = transaction?.resolvedCardToken ?? null;
    // Only the original zero-amount special_free needs the card-first gate: a
    // €1 auth_settle special_free proves itself with settled money, exactly
    // like special_1eur.
    const requiresReusableCard =
      freshPurchase.tier === 'special_free' &&
      freshPurchase.paymentAction === 'auth_0_amount';

    // A zero-amount authorization proves neither that Solidgate returned a
    // reusable credential nor that we can attempt the scheduled charge. Keep
    // the exact order pending until its verified status response contains one;
    // no local success state, intro claim, account, or entitlement may precede
    // that proof.
    if (requiresReusableCard && !cardToken) {
      cardToken = await durableSpecialFreeCardToken(supabase, {
        paymentEnvironment,
        order: freshOrder,
        purchase: freshPurchase,
        subscriptionId,
      });
      if (!cardToken) {
        return NextResponse.json(
          {
            ok: false,
            pending: true,
            status: order.status ?? null,
            code: 'reusable_card_unverified',
          },
          { status: 202 },
        );
      }
    }

    // Only the still-pending opener row may be finalized by the browser. If a
    // webhook already made it trialing/active, verify that durable winner below
    // without downgrading its order state or subscription calendar.
    let grantOrderId: string | null = null;
    if (freshOrder.status === 'pending') {
      let orderFinalizer = supabase
        .from('orders')
        .update({
          status: subscriptionId ? 'trialing' : 'completed',
          solidgate_subscription_id: subscriptionId,
          solidgate_payment_status: order.status,
          // Gross is part of the immutable provider binding. The database
          // opener/trigger also establishes it; this closes a rolling-deploy
          // row created by the legacy app before that trigger existed.
          solidgate_original_amount_cents: freshPurchase.amountCents,
        })
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .eq('id', freshPurchase.orderDbId)
        .eq('session_id', freshPurchase.sessionId)
        .eq('psp', 'solidgate')
        .eq('product_name', freshPurchase.productCode)
        .eq('product_slug', freshPurchase.productCode)
        .eq('amount_cents', freshOrder.amount_cents)
        .eq('currency', freshPurchase.currency)
        .eq('solidgate_refunded_amount_cents', freshOrder.solidgate_refunded_amount_cents)
        .eq('solidgate_chargeback_amount_cents', freshOrder.solidgate_chargeback_amount_cents)
        .eq('status', 'pending');
      orderFinalizer = freshOrder.solidgate_payment_status == null
        ? orderFinalizer.is('solidgate_payment_status', null)
        : orderFinalizer.eq('solidgate_payment_status', freshOrder.solidgate_payment_status);
      orderFinalizer = freshOrder.solidgate_original_amount_cents == null
        ? orderFinalizer.is('solidgate_original_amount_cents', null)
        : orderFinalizer.eq(
            'solidgate_original_amount_cents',
            freshOrder.solidgate_original_amount_cents,
          );
      orderFinalizer = freshOrder.solidgate_subscription_id == null
        ? orderFinalizer.is('solidgate_subscription_id', null)
        : orderFinalizer.eq('solidgate_subscription_id', freshOrder.solidgate_subscription_id);
      orderFinalizer = freshOrder.solidgate_chargeback_id == null
        ? orderFinalizer.is('solidgate_chargeback_id', null)
        : orderFinalizer.eq('solidgate_chargeback_id', freshOrder.solidgate_chargeback_id);
      orderFinalizer = freshOrder.solidgate_chargeback_status == null
        ? orderFinalizer.is('solidgate_chargeback_status', null)
        : orderFinalizer.eq('solidgate_chargeback_status', freshOrder.solidgate_chargeback_status);
      const { data: grantedOrder, error: orderUpdateError } = await orderFinalizer
        .select('id')
        .maybeSingle();
      if (orderUpdateError) {
        console.error('[solidgate/grant] order update failed:', orderUpdateError?.message);
        return NextResponse.json({ error: 'Failed to record order' }, { status: 500 });
      }
      grantOrderId = grantedOrder?.id ?? null;
    }
    if (!grantOrderId) {
      // A successful webhook can win the same transition after our fresh read.
      // A zero-row CAS is therefore not automatically a reversal: accept only
      // the identical durable success binding and re-check its grant guard.
      const { data: finalizedRawOrder, error: finalizedOrderError } = await supabase
        .from('orders')
        .select(ORDER_GRANT_COLUMNS)
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (finalizedOrderError) {
        return NextResponse.json({ error: 'Failed to verify finalized order' }, { status: 500 });
      }
      const finalizedOrder = finalizedRawOrder as BoundOrder | null;
      const finalizedBinding = finalizedOrder
        ? canonicalMainOrderBinding(orderId, sessionId, finalizedOrder)
        : null;
      const finalizedBlock = finalizedOrder
        ? await replayBlockReason(supabase, paymentEnvironment, finalizedOrder)
        : 'order_status';
      if (
        !finalizedOrder ||
        !finalizedBinding ||
        !sameMainBinding(freshPurchase, finalizedBinding) ||
        finalizedBlock ||
        !['completed', 'trialing', 'active'].includes(finalizedOrder.status) ||
        finalizedOrder.solidgate_original_amount_cents !== freshPurchase.amountCents ||
        finalizedOrder.solidgate_payment_status !== order.status ||
        finalizedOrder.solidgate_subscription_id !== subscriptionId
      ) return replayBlockedResponse();
      grantOrderId = finalizedOrder.id;
    }

    // Publish the exact captured generation after the binding finalizer wins
    // its reversal CAS. Even when Solidgate omits the reusable token, the
    // source watermark must land before we expose success; otherwise a delayed
    // older callback could restore an obsolete OTO card.
    await upsertSessionVault(supabase, {
      sessionId,
      sourceOrderId: grantOrderId,
      customerAccountId: freshPurchase.customerAccountId,
      card: transaction
        ? {
            token: cardToken,
            originalPaymentMethod: transaction.resolvedOriginalPaymentMethod,
            brand: transaction.resolvedCardBrand,
            maskedNumber: transaction.resolvedCardNumber,
          }
        : null,
    });

    if (requiresReusableCard) {
      const persistedVault = await getSessionVault(supabase, sessionId, paymentEnvironment);
      const persistedCardToken = typeof persistedVault?.cardToken === 'string'
        ? persistedVault.cardToken.trim()
        : '';
      const persistedOriginalPaymentMethod = persistedVault?.cardOriginalPaymentMethod;
      const vaultBindingMatches = Boolean(
        persistedVault &&
        persistedVault.paymentEnvironment === paymentEnvironment &&
        persistedVault.sessionId === sessionId &&
        persistedVault.customerAccountId === freshPurchase.customerAccountId &&
        persistedVault.sourceOrderId &&
        persistedCardToken &&
        typeof persistedOriginalPaymentMethod === 'string' &&
        REUSABLE_ORIGINAL_PAYMENT_METHOD_SET.has(
          persistedOriginalPaymentMethod as SolidgateOriginalPaymentMethod,
        )
      );
      const cardReady = vaultBindingMatches
        ? await specialFreeCardReady(supabase, grantOrderId)
        : false;
      if (!vaultBindingMatches || !cardReady) {
        console.error('[solidgate/grant] special-free reusable card is not durably ready', {
          orderId,
          grantOrderId,
        });
        return NextResponse.json(
          {
            ok: false,
            pending: true,
            status: order.status ?? null,
            code: 'reusable_card_unverified',
          },
          { status: 202 },
        );
      }
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('last_oto_step, updated_at, quiz_answers')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError || !session) {
      return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
    }

    // Solidgate product uniqueness is scoped to one product ID, while our six
    // introductory variants use six IDs. Consume the merchant-side claim before
    // the only access grant. This is idempotent for the same subscription and
    // fails closed if a cross-session/cross-tier subscription ever slips through.
    if (INTRO_OFFER_TIERS.has(freshPurchase.tier)) {
      if (!subscriptionId) {
        console.error('[solidgate/grant] introductory checkout missing subscription/email', {
          orderId,
          subscriptionId,
        });
        return NextResponse.json(
          { error: 'Unable to verify introductory subscription', code: 'intro_offer_unverified' },
          { status: 500 },
        );
      }
      const { data: consumeResult, error: consumeError } = await supabase.rpc(
        'consume_solidgate_intro_offer',
        {
          p_payment_environment: paymentEnvironment,
          p_email_hash: await introOfferEmailHash(freshPurchase.customerEmail),
          p_session_id: sessionId,
          p_tier: freshPurchase.tier,
          p_subscription_id: subscriptionId,
        },
      );
      if (consumeError) {
        console.error('[solidgate/grant] intro consumption failed:', consumeError.message);
        return NextResponse.json(
          { error: 'Unable to verify introductory subscription', code: 'intro_offer_unverified' },
          { status: 500 },
        );
      }
      // `superseded` means this buyer was charged for a subscription the ledger
      // did not expect. The money has already moved, so refusing the grant here
      // would leave a paying customer with no access — the failure this used to
      // produce. Grant, and shout: the claim row now carries the extra
      // subscription id for refund reconciliation.
      if (!introOfferConsumeGranted(consumeResult as IntroOfferConsumeResult)) {
        console.error('[solidgate/grant] unexpected intro consume result', {
          orderId,
          sessionId,
          subscriptionId,
          result: consumeResult,
        });
        return NextResponse.json(
          { error: 'Unable to verify introductory subscription', code: 'intro_offer_unverified' },
          { status: 500 },
        );
      }
      if (introOfferConsumeNeedsRefund(consumeResult as IntroOfferConsumeResult)) {
        console.error('[solidgate/grant] duplicate intro subscription — granted, needs refund', {
          orderId,
          sessionId,
          subscriptionId,
        });
      }
    }

    // The OTO chain is gated on this cookie, so it is signed before any
    // best-effort work that could fail.
    const signed = await signPaymentCookie(orderId, sessionId);
    const resumeTo = session.last_oto_step
      ? resolvePostLoginDestination({
          lastOtoStep: session.last_oto_step,
          updatedAt: session.updated_at,
        })
      : '/oto/1';

    let authLinked = false;
    let userId = freshOrder.user_id ?? null;
    if (freshPurchase.customerEmail) {
      const link = await linkAuthUser({
        email: freshPurchase.customerEmail,
        sessionId,
        userId,
        orderMatch: { column: 'solidgate_order_id', value: orderId },
        supabaseAdmin: supabase,
        logPrefix: '[solidgate/grant]',
      });
      authLinked = link.linked;
      userId = link.userId;

      // The member area bills the ACCOUNT, the funnel vaulted the card against
      // the SESSION. Promote it now or the buyer's first PWA purchase would ask
      // for a card they already gave us.
      if (userId) {
        await promoteSessionVaultToAccount(supabase, { userId, sessionId });
      }
    }

    // Persist first-touch acquisition as soon as the payment route links the
    // auth account. PWA upsells can now inherit UTM data without waiting for an
    // unordered provider callback; the webhook repeats this atomically.
    const utm = trackingUtm(pendingOrder.tracking_metadata);
    if (userId && Object.keys(utm).length > 0) {
      const { error: acquisitionError } = await supabase.rpc(
        'persist_user_acquisition_attribution',
        {
          p_payment_environment: paymentEnvironment,
          p_user_id: userId,
          p_source_session_id: sessionId,
          p_source_order_id: grantOrderId,
          p_captured_at: pendingOrder.created_at,
          p_utm_source: utm.utm_source,
          p_utm_medium: utm.utm_medium,
          p_utm_campaign: utm.utm_campaign,
          p_utm_content: utm.utm_content,
          p_utm_term: utm.utm_term,
        },
      );
      if (acquisitionError) {
        // Payment/access must not fail because an analytics write failed; the
        // durable webhook path will retry the same atomic first-touch write.
        console.error('[solidgate/grant] acquisition persist failed:', acquisitionError.message);
      }
    }

    // Account linking can take long enough for a terminal webhook to land.
    // Re-check immediately before the only call which can grant access.
    const { data: preGrantRawOrder, error: preGrantOrderError } = await supabase
      .from('orders')
      .select(ORDER_GRANT_COLUMNS)
      .eq('payment_environment', paymentEnvironment)
      .eq('solidgate_order_id', orderId)
      .maybeSingle();
    if (preGrantOrderError) {
      return NextResponse.json({ error: 'Failed to verify payment state' }, { status: 500 });
    }
    if (
      !preGrantRawOrder ||
      await replayBlockReason(supabase, paymentEnvironment, preGrantRawOrder as unknown as BoundOrder)
    ) {
      return replayBlockedResponse();
    }

    if (!userId || !subscriptionId) {
      // The webhook can still finish account resolution. Keep the browser on
      // this exact order (5xx is polled as pending) rather than returning a
      // success cookie with no durable access row.
      return NextResponse.json({ error: 'Purchase access is still provisioning' }, { status: 503 });
    }

    const fallbackExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    type MainEntitlementGrantRpc = (
      fn: 'grant_solidgate_main_entitlement',
      args: {
        p_payment_environment: PaymentEnvironment;
        p_order_id: string;
        p_user_id: string;
        p_product_slug: string;
        p_subscription_id: string;
        p_amount_cents: number;
        p_fallback_expires_at: string;
      },
    ) => PromiseLike<{ data: boolean | null; error: { message: string } | null }>;
    const grantEntitlement = supabase.rpc.bind(supabase) as unknown as MainEntitlementGrantRpc;
    const { data: entitlementGrantResult, error: entitlementGrantError } = await grantEntitlement(
      'grant_solidgate_main_entitlement',
      {
        p_payment_environment: paymentEnvironment,
        p_order_id: grantOrderId,
        p_user_id: userId,
        p_product_slug: freshPurchase.productCode,
        p_subscription_id: subscriptionId,
        p_amount_cents: freshPurchase.amountCents,
        p_fallback_expires_at: fallbackExpiresAt,
      },
    );
    const entitlementGranted = entitlementGrantError == null && entitlementGrantResult === true;
    if (!entitlementGranted) {
      if (entitlementGrantError) {
        console.error('[solidgate/grant] entitlement RPC failed:', entitlementGrantError.message);
      }
      const { data: finalRawOrder } = await supabase
        .from('orders')
        .select(ORDER_GRANT_COLUMNS)
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (
        !finalRawOrder ||
        await replayBlockReason(supabase, paymentEnvironment, finalRawOrder as unknown as BoundOrder)
      ) {
        return replayBlockedResponse();
      }
      return NextResponse.json({ error: 'Failed to grant purchase' }, { status: 500 });
    }

    // One small durable insert replaces every slow customer-side effect on the
    // redirect path. Welcome eligibility is per captured main order rather than
    // the transient auth-user-creation result, so a webhook/grant crash race
    // cannot lose it. The stable outbox key keeps both writers idempotent.
    if (userId) {
      // Browser attribution for the server-side CAPI Purchase: the grant runs
      // inside the buyer's own request, so the Meta cookies and client
      // identity are readable here — the webhook backstop never has them.
      const cookieHeader = request.headers.get('cookie') ?? '';
      const readCookie = (name: string): string | undefined => {
        const match = cookieHeader
          .split('; ')
          .find((part) => part.startsWith(`${name}=`));
        const value = match?.slice(name.length + 1);
        if (!value) return undefined;
        // A malformed % sequence in a real-world cookie must degrade to the
        // raw value, never throw: this runs AFTER the entitlement grant, and a
        // URIError here would 500 an already-paid buyer's grant response.
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const forwardedFor = request.headers.get('x-forwarded-for') ?? '';
      const clientIp = forwardedFor.split(',')[0]?.trim() || undefined;
      await enqueueMainPurchaseEnrichment({
        supabase,
        paymentEnvironment,
        solidgateOrderId: orderId,
        userId,
        sendWelcomeEmail: true,
        metaAttribution: {
          fbp: readCookie('_fbp'),
          fbc: readCookie('_fbc'),
          client_ip_address: clientIp,
          client_user_agent: request.headers.get('user-agent') ?? undefined,
          event_source_url: request.headers.get('referer') ?? undefined,
        },
      });
      // Flush the HTTP response first, then wake the environment-scoped worker
      // in this invocation. Production's five-minute cron remains the recovery
      // path; Preview has no cron, so after() is essential there.
      after(async () => {
        try {
          await Promise.all([
            drainSolidgateFulfillmentOutbox({ paymentEnvironment, limit: 5 }),
            drainSolidgateSubscriptionTokenSync({
              paymentEnvironment,
              userId,
              limit: 5,
            }),
          ]);
        } catch (enrichmentError) {
          console.error(
            '[solidgate/grant] background enrichment drain failed:',
            enrichmentError instanceof Error ? enrichmentError.message : enrichmentError,
          );
        }
      });
    }

    const response = NextResponse.json({
      ok: true,
      status: order.status,
      captured,
      settled,
      fullyCaptured,
      authorizedTrial,
      resumeTo,
      authLinked,
      entitlementGranted,
      subscriptionId,
    });
    response.cookies.set(PAYMENT_COOKIE_NAME, signed, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: PAYMENT_COOKIE_MAX_AGE,
      path: '/',
    });
    return clearMainAcceptedCookie(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[solidgate/grant]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
