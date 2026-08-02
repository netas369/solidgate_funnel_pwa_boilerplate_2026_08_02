import { after, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { resolveProductPrice, LOCALE_CURRENCY_MAP, type Locale, type ProductId } from '@repo/shared/price-map';
import {
  classifySolidgatePayment,
  SolidgateClient,
  chargeSavedCard,
  subscribeSavedCard,
  getSolidgateKeys,
  paymentTypeForOriginalPaymentMethod,
  paymentEnvironmentForVercel,
  resolveSolidgateVerifyUrl,
  solidgateGrantBlockReason,
  solidgateCapturedAmount,
  type PaymentEnvironment,
  type SolidgateChargeResult,
} from '@repo/shared/solidgate';
import {
  ADDON_TRIAL_INTRO_AMOUNTS,
  PRODUCT_ID_TO_CODE,
  SOLIDGATE_PRODUCT_CODES,
} from '@repo/shared/solidgate/catalog';
import { solidgateOrderDescription } from '@repo/shared/locale-prefixes';
import catalogIds from '@repo/shared/solidgate/catalog-ids.json';
import { authorizeSolidgateSession } from '@/lib/payment/solidgate-access';
import { configuredFunnelOrigins } from '@/lib/payment/funnel-origins';
import {
  drainSolidgateFulfillmentOutbox,
  enqueueCapturedOtoFulfillment,
} from '@/lib/payment/solidgate-fulfillment';
import {
  sanitizeAttributionSnapshot,
  selectFirstTouchUtm,
} from '@/features/analytics/lib/attribution';
import {
  FUNNEL_CODE,
  isSubscriptionOto,
  otoProductContext,
  subscriptionOtoCatalogKey,
} from '@/features/analytics/lib/checkout-context';

/**
 * One-click OTO charges on the card vaulted at checkout — one route for the
 * whole chain; each offer differs only by slug, price and side effect.
 *
 * Two shapes, both POST /recurring with the saved token:
 *   a subscription OTO (see SUBSCRIPTION_OTO_CATALOG_KEYS in checkout-context)
 *                    → starts a SUBSCRIPTION on the token (product-based)
 *   everything else  → a one-off charge (amount-based)
 *
 * A 3DS step-up on a token charge is a REDIRECT (verify_url), not an inline
 * modal: there is no confirmCardPayment equivalent. The client sends the buyer
 * to verify_url and Solidgate returns them to ?sg_confirm=<orderId>, which
 * finalises through the confirm branch here.
 */

export const dynamic = 'force-dynamic';

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Slot number for every OTO the chain may sell. Derived from the catalog: any
 * ProductId matching /^oto(\d+)_/ belongs to that slot. Anything not listed
 * here is rejected outright, so adding an upsell is a CATALOG edit, not a
 * change to this route.
 */
const OTO_STEP_BY_PRODUCT: Partial<Record<ProductId, number>> = Object.fromEntries(
  (Object.keys(PRODUCT_ID_TO_CODE) as ProductId[])
    .map((slug) => [slug, /^oto(\d+)_/.exec(slug)?.[1]] as const)
    .filter((entry): entry is readonly [ProductId, string] => entry[1] !== undefined)
    .map(([slug, step]) => [slug, Number(step)]),
);

/** Everything the OTO chain may sell. */
const OTO_SLUGS = new Set<ProductId>(Object.keys(OTO_STEP_BY_PRODUCT) as ProductId[]);

/** Highest OTO slot number, used to bound the 3DS return-URL allowlist. */
const MAX_OTO_STEP = Math.max(...Object.values(OTO_STEP_BY_PRODUCT).map((n) => n ?? 0));

// Catalog code → OTO slug (unique per offer). The confirm branch resolves the
// product from the ORDER ROW, never from the client's slug: a 3DS redirect
// reloads the page and resets its selection state, so on OTO3 the client would
// report the default bundle — and the buyer would be granted (and mailed) a
// different product than the one they paid for.
const CODE_TO_OTO_SLUG = new Map<string, ProductId>(
  [...OTO_SLUGS].map((s) => [PRODUCT_ID_TO_CODE[s], s]),
);

type CatalogIds = Record<string, { product_id: string; prices: Record<string, string> }>;

/** /oto/1 .. /oto/{MAX_OTO_STEP}, optionally locale-prefixed. */
const OTO_RETURN_PATH_PATTERN = new RegExp(
  `^\\/(?:[^/]+\\/)?oto\\/[1-${MAX_OTO_STEP}]\\/?$`,
);

function validatedOtoReturnUrl(request: Request, input: unknown): URL | null {
  if (typeof input !== 'string' || !input) return null;
  try {
    const candidate = new URL(input);
    if (candidate.username || candidate.password) return null;
    const requestOrigin = new URL(request.url).origin;
    const configured = process.env.NEXT_PUBLIC_FUNNEL_URL;
    if (process.env.VERCEL_ENV === 'production' && !configured) return null;
    // Includes the www/apex sibling — production serves www while the env var
    // names the apex, and rejecting the sibling 400s every OTO charge there.
    const allowedOrigins = configuredFunnelOrigins();
    if (process.env.VERCEL_ENV !== 'production') allowedOrigins.add(requestOrigin);
    if (!allowedOrigins.has(candidate.origin)) return null;
    // Only an OTO page is a valid ACS return destination. Strip all incoming
    // query/hash state; the server adds the one trusted sg_confirm value later.
    if (!OTO_RETURN_PATH_PATTERN.test(candidate.pathname)) return null;
    candidate.search = '';
    candidate.hash = '';
    return candidate;
  } catch {
    return null;
  }
}

interface SolidgateOrderStatus {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    settled_amount?: number | null;
    currency?: string;
    subscription_id?: string;
    product_id?: string;
    customer_account_id?: string;
  };
  transaction?: {
    id?: string;
    operation?: string;
    status?: string;
    amount?: number;
    currency?: string;
    card_token?: { token?: string };
  };
  transactions?: Record<string, {
    id?: string;
    operation?: string;
    status?: string;
    amount?: number;
    currency?: string;
    card_token?: { token?: string };
  }>;
  verify_url?: string;
  verify_link?: string;
  error?: {
    code?: unknown;
    messages?: unknown;
  };
}

const ORDER_GRANT_COLUMNS = 'id,user_id,psp,product_name,solidgate_order_id,session_id,product_slug,status,amount_cents,currency,solidgate_original_amount_cents,solidgate_product_id,solidgate_payment_action,tracking_metadata,solidgate_customer_email,solidgate_checkout_locale,solidgate_checkout_identity_bound_at,solidgate_checkout_identity_legacy,solidgate_subscription_id,solidgate_payment_status,solidgate_verify_url,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_submission_token,solidgate_submission_started_at' as const;

type BoundOrder = {
  id: string;
  user_id: string | null;
  psp: string;
  product_name: string;
  solidgate_order_id: string | null;
  session_id: string | null;
  product_slug: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  solidgate_original_amount_cents: number | null;
  solidgate_product_id: string | null;
  solidgate_payment_action: string | null;
  tracking_metadata: unknown;
  solidgate_customer_email: string | null;
  solidgate_checkout_locale: string | null;
  solidgate_checkout_identity_bound_at: string | null;
  solidgate_checkout_identity_legacy: boolean;
  solidgate_subscription_id: string | null;
  solidgate_payment_status: string | null;
  solidgate_verify_url: string | null;
  solidgate_refunded_amount_cents: number;
  solidgate_chargeback_id: string | null;
  solidgate_chargeback_status: string | null;
  solidgate_chargeback_amount_cents: number;
  solidgate_submission_token: string | null;
  solidgate_submission_started_at: string | null;
};

type OpenedOtoOrder = {
  order_db_id: string;
  solidgate_order_id: string;
  order_status: string;
  solidgate_payment_status: string | null;
  is_new: boolean;
  should_submit: boolean;
  needs_reconcile: boolean;
  claim_token: string | null;
  bound_original_amount_cents: number;
  bound_currency: string;
  bound_tracking_metadata: unknown;
  bound_customer_email: string;
  bound_checkout_locale: string;
  bound_solidgate_product_id: string | null;
  bound_solidgate_payment_action: string;
};

type BoundOtoContext = {
  productId: ProductId;
  productCode: string;
  amountCents: number;
  currency: string;
  locale: Locale;
  customerEmail: string;
  metadata: Record<string, string>;
  solidgateProductId: string | null;
  paymentAction: 'auth_settle';
};

/** Temporary typed boundary until the checked-in DB types include the new RPC. */
function callOtoRpc<T>(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string } | null }> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    rpcName: string,
    rpcArgs: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: { message: string } | null }>;
  return rpc(name, args);
}

/** Provider states that prove the one-click submission was accepted. */
const ACCEPTED_PENDING_PROVIDER_STATUSES = new Set(['processing', 'auth_ok']);
const UNKNOWN_PROVIDER_STATUS = 'status_unknown';
const CAPTURED_ONE_TIME_PROVIDER_STATUSES = new Set(['settle_ok', 'partial_settled']);
const CAPTURED_SUBSCRIPTION_PROVIDER_STATUSES = new Set([
  'auth_ok',
  'settle_ok',
  'partial_settled',
]);

function boundProductId(order: BoundOrder): ProductId | null {
  return CODE_TO_OTO_SLUG.get(order.product_slug ?? '') ?? null;
}

function initialAmount(productId: ProductId, locale: Locale): number {
  // A subscription OTO settles its PSP product's trial_price, not the
  // recurring rebill amount held in PRICE_MAP.
  return isSubscriptionOto(productId)
    ? ADDON_TRIAL_INTRO_AMOUNTS[LOCALE_CURRENCY_MAP[locale]]
    : resolveProductPrice(productId, locale).amountCents;
}

function flatStringMetadata(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 10) return null;
  const metadata: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') return null;
    metadata[key] = entry;
  }
  return metadata;
}

function sameFlatMetadata(left: unknown, right: unknown): boolean {
  const leftMetadata = flatStringMetadata(left);
  const rightMetadata = flatStringMetadata(right);
  if (!leftMetadata || !rightMetadata) return false;
  const leftEntries = Object.entries(leftMetadata).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(rightMetadata).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * Resolve every value that can affect an existing provider order from the
 * immutable order snapshot. Session locale/email and fresh attribution are
 * deliberately creation-only inputs.
 */
function boundOtoContext(order: BoundOrder, sessionId: string): BoundOtoContext | null {
  const productId = boundProductId(order);
  const localeValue = order.solidgate_checkout_locale;
  if (
    !productId
    || order.psp !== 'solidgate'
    || order.session_id !== sessionId
    || order.product_name !== order.product_slug
    || typeof localeValue !== 'string'
    || !Object.prototype.hasOwnProperty.call(LOCALE_CURRENCY_MAP, localeValue)
    || order.solidgate_checkout_identity_legacy
    || !order.solidgate_checkout_identity_bound_at
    || !order.solidgate_customer_email
    || !order.solidgate_customer_email.includes('@')
    || order.solidgate_payment_action !== 'auth_settle'
    || !Number.isSafeInteger(order.solidgate_original_amount_cents)
    || (order.solidgate_original_amount_cents ?? -1) < 0
  ) return null;

  const locale = localeValue as Locale;
  const productContext = otoProductContext(productId, locale);
  const metadata = flatStringMetadata(order.tracking_metadata);
  if (!productContext || !metadata) return null;

  const amountCents = order.solidgate_original_amount_cents!;
  const currency = order.currency.toLowerCase();
  const priceBindingMatches = isSubscriptionOto(productId)
    ? Boolean(metadata.price_id?.trim())
      && metadata.locale === undefined
      && Boolean(order.solidgate_product_id?.trim())
    : metadata.locale === locale && metadata.price_id === undefined;
  if (
    !/^[a-z]{3}$/.test(currency)
    || metadata.session_id !== sessionId
    || metadata.product_slug !== productId
    || metadata.funnel_code !== FUNNEL_CODE
    || metadata.funnel_variant !== productContext.funnel_variant
    || (!isSubscriptionOto(productId) && order.solidgate_product_id !== null)
    || !priceBindingMatches
  ) return null;

  return {
    productId,
    productCode: PRODUCT_ID_TO_CODE[productId],
    amountCents,
    currency,
    locale,
    customerEmail: order.solidgate_customer_email,
    metadata,
    solidgateProductId: order.solidgate_product_id,
    paymentAction: 'auth_settle',
  };
}

function otoTrackingFromBound(context: BoundOtoContext) {
  const tracking = otoProductContext(context.productId, context.locale, {
    amountCents: context.amountCents,
    currency: context.currency,
  });
  if (!tracking) return null;
  const boundPriceId = context.metadata.price_id;
  return boundPriceId
    ? { ...tracking, price_id: boundPriceId, solidgate_price_id: boundPriceId }
    : tracking;
}

function openedBindingMatches(
  opened: OpenedOtoOrder,
  order: BoundOrder,
  context: BoundOtoContext,
): boolean {
  return opened.bound_original_amount_cents === context.amountCents
    && opened.bound_currency.toLowerCase() === context.currency
    && opened.bound_customer_email === context.customerEmail
    && opened.bound_checkout_locale === context.locale
    && opened.bound_solidgate_product_id === context.solidgateProductId
    && opened.bound_solidgate_payment_action === context.paymentAction
    && sameFlatMetadata(opened.bound_tracking_metadata, order.tracking_metadata);
}

function providerOrderFromResult(result: SolidgateChargeResult): NonNullable<SolidgateOrderStatus['order']> {
  return {
    order_id: result.providerOrderId,
    status: result.providerStatus,
    amount: result.orderAmount,
    settled_amount: result.settledAmount,
    currency: result.currency,
    subscription_id: result.subscriptionId ?? undefined,
    product_id: result.productId,
    customer_account_id: result.customerAccountId,
  };
}

function providerOrderFromStatus(
  response: SolidgateOrderStatus,
  expectedAmount: number,
): NonNullable<SolidgateOrderStatus['order']> | null {
  if (!response.order) return null;
  const capturedAmount = solidgateCapturedAmount(response, expectedAmount);
  return {
    ...response.order,
    ...(capturedAmount !== null && { settled_amount: capturedAmount }),
  };
}

function providerStatusProvesAbsence(status: SolidgateOrderStatus): boolean {
  if (status.order || !status.error || typeof status.error !== 'object') return false;
  if (status.error.code !== '2.01' || !status.error.messages) return false;
  if (typeof status.error.messages !== 'object' || Array.isArray(status.error.messages)) {
    return false;
  }
  const orderMessages = (status.error.messages as Record<string, unknown>).order;
  return Array.isArray(orderMessages) && orderMessages.some(
    (message) => typeof message === 'string'
      && message.trim().toLowerCase() === 'order not found.',
  );
}

function safeVerifyUrl(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

async function persistNextOto(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  sessionId: string,
  productId: ProductId,
): Promise<{ lastOtoStep: string; resumeTo: `/oto/${number}` }> {
  const currentStep = OTO_STEP_BY_PRODUCT[productId];
  if (!currentStep) throw new Error(`No OTO progress step for ${productId}`);

  const { data, error } = await callOtoRpc<Array<{
    persisted_step: number;
    advanced: boolean;
    conflict: boolean;
  }>>(supabase, 'advance_solidgate_oto_progress', {
    p_payment_environment: paymentEnvironment,
    p_session_id: sessionId,
    p_current_step: currentStep,
    // A provider-accepted purchase is authoritative evidence that the buyer
    // reached this offer, so it may repair a missed skip checkpoint.
    p_allow_catch_up: true,
  });
  if (error) throw new Error(`Failed to persist OTO progress: ${error.message}`);
  const persistedStep = data?.[0]?.persisted_step;
  if (
    !data?.[0]
    || data[0].conflict
    || typeof persistedStep !== 'number'
    || !Number.isInteger(persistedStep)
    || persistedStep < currentStep + 1
    || persistedStep > 8
  ) {
    throw new Error('Failed to persist OTO progress: invalid RPC result');
  }
  return {
    lastOtoStep: String(persistedStep),
    resumeTo: `/oto/${persistedStep}`,
  };
}

async function persistProviderState(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  orderId: string,
  values: { solidgate_payment_status: string; solidgate_verify_url?: string | null },
  claimToken: string | null,
): Promise<boolean> {
  let update = supabase
    .from('orders')
    .update({
      ...values,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    } as never)
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', orderId)
    .eq('status', 'pending');
  update = claimToken
    ? update.eq('solidgate_submission_token' as never, claimToken as never)
    : update.is('solidgate_submission_token' as never, null);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) throw new Error(`Failed to persist provider state: ${error.message}`);
  return Boolean(data?.id);
}

async function retireFailedOrder(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  orderId: string,
  providerStatus: string | null | undefined,
  claimToken: string | null,
): Promise<boolean> {
  let update = supabase
    .from('orders')
    .update({
      status: 'failed',
      // Keep solidgate_original_amount_cents as the immutable binding while
      // releasing only explicit terminal failures for a later OTO attempt.
      amount_cents: 0,
      solidgate_payment_status: providerStatus ?? 'failed',
      solidgate_verify_url: null,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    } as never)
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', orderId)
    .eq('status', 'pending');
  update = claimToken
    ? update.eq('solidgate_submission_token' as never, claimToken as never)
    : update.is('solidgate_submission_token' as never, null);
  const { data, error } = await update.select('id').maybeSingle();
  if (error) throw new Error(`Failed to retire provider order: ${error.message}`);
  return Boolean(data?.id);
}

function assertProviderBinding(params: {
  order: NonNullable<SolidgateOrderStatus['order']>;
  bound: BoundOrder;
  orderId: string;
  customerAccountId: string;
  productId: ProductId;
  expectedAmount: number;
  currency: string;
  captured?: boolean;
}): void {
  const {
    order,
    bound,
    orderId,
    customerAccountId,
    productId,
    expectedAmount,
    currency,
    captured = false,
  } = params;
  if (
    order.order_id !== orderId
    || order.customer_account_id !== customerAccountId
    || bound.solidgate_order_id !== orderId
    || bound.product_slug !== PRODUCT_ID_TO_CODE[productId]
    || bound.solidgate_original_amount_cents !== expectedAmount
    || bound.currency.toLowerCase() !== currency.toLowerCase()
    || order.amount !== expectedAmount
    || order.currency?.toLowerCase() !== currency.toLowerCase()
  ) {
    throw new Error('Solidgate order identity, amount, currency, or product binding mismatch');
  }
  // The card API does not publish order.settled_amount. `settle_ok` is the
  // full-capture state; exact partial capture is normalized from successful
  // settle transactions by providerOrderFromStatus/chargeSavedCard.
  if (captured) {
    const fullySettled = order.status === 'settle_ok';
    const exactPartial =
      order.status === 'partial_settled' && order.settled_amount === expectedAmount;
    const zeroValueTrial =
      expectedAmount === 0 && order.status === 'auth_ok' && order.amount === 0;
    if (!fullySettled && !exactPartial && !zeroValueTrial) {
      throw new Error('Solidgate captured amount binding mismatch');
    }
  }

  if (isSubscriptionOto(productId)) {
    if (
      !bound.solidgate_product_id
      || order.product_id !== bound.solidgate_product_id
      || (captured && !order.subscription_id)
    ) {
      throw new Error('Solidgate subscription OTO product binding mismatch');
    }
  } else if (order.product_id) {
    // Amount-based OTOs deliberately carry no Solidgate catalog product. A
    // provider product here means this order ID is not the one we opened.
    throw new Error('Unexpected Solidgate product on amount-based OTO');
  }
}

async function readBoundOrder(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  paymentEnvironment: PaymentEnvironment,
  orderId: string,
): Promise<{ order: BoundOrder | null; error: string | null }> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_GRANT_COLUMNS)
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  return {
    order: data as BoundOrder | null,
    error: error?.message ?? null,
  };
}

function sameBoundOtoPurchase(params: {
  candidate: BoundOrder;
  reference: BoundOrder;
  sessionId: string;
  productId: ProductId;
  orderId: string;
  expectedAmount: number;
  currency: string;
}): boolean {
  const {
    candidate, reference, sessionId, productId, orderId, expectedAmount, currency,
  } = params;
  return candidate.id === reference.id
    && candidate.solidgate_order_id === orderId
    && candidate.session_id === sessionId
    && candidate.product_slug === PRODUCT_ID_TO_CODE[productId]
    && boundProductId(candidate) === productId
    && candidate.solidgate_original_amount_cents === expectedAmount
    && reference.solidgate_original_amount_cents === expectedAmount
    && candidate.currency.toLowerCase() === currency.toLowerCase()
    && candidate.solidgate_customer_email === reference.solidgate_customer_email
    && candidate.solidgate_checkout_locale === reference.solidgate_checkout_locale
    && candidate.solidgate_product_id === reference.solidgate_product_id
    && candidate.solidgate_payment_action === reference.solidgate_payment_action
    && candidate.solidgate_checkout_identity_bound_at
      === reference.solidgate_checkout_identity_bound_at
    && !candidate.solidgate_checkout_identity_legacy
    && sameFlatMetadata(candidate.tracking_metadata, reference.tracking_metadata);
}

function isDurableCapturedOtoOrder(order: BoundOrder, productId: ProductId): boolean {
  const providerStatus = order.solidgate_payment_status;
  if (!providerStatus) return false;
  if (isSubscriptionOto(productId)) {
    return order.status === 'trialing'
      && Boolean(order.solidgate_subscription_id)
      && CAPTURED_SUBSCRIPTION_PROVIDER_STATUSES.has(providerStatus);
  }
  return order.status === 'completed'
    && order.solidgate_subscription_id === null
    && CAPTURED_ONE_TIME_PROVIDER_STATUSES.has(providerStatus);
}

async function acceptedPendingResponse(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  paymentEnvironment: PaymentEnvironment;
  sessionId: string;
  productId: ProductId;
  bound: BoundOrder;
  orderId: string;
  amountCents: number;
  currency: string;
  providerStatus: string;
  claimToken: string | null;
  orderAmountCents?: number;
  settledAmountCents?: number | null;
}) {
  const persisted = await persistProviderState(
    params.supabase,
    params.paymentEnvironment,
    params.orderId,
    { solidgate_payment_status: params.providerStatus, solidgate_verify_url: null },
    params.claimToken,
  );
  let responseProviderStatus = params.providerStatus;
  let responseSettledAmount = params.settledAmountCents;
  if (!persisted) {
    // A signed settlement webhook (or the other identical browser request)
    // can clear the submitter token before this CAS. Re-read the winner and
    // advance only for the exact same, still-grantable binding.
    const winner = await readBoundOrder(
      params.supabase,
      params.paymentEnvironment,
      params.orderId,
    );
    if (winner.error) {
      return NextResponse.json({ error: 'Failed to verify accepted payment' }, { status: 500 });
    }
    if (
      !winner.order
      || !sameBoundOtoPurchase({
        candidate: winner.order,
        reference: params.bound,
        sessionId: params.sessionId,
        productId: params.productId,
        orderId: params.orderId,
        expectedAmount: params.amountCents,
        currency: params.currency,
      })
    ) {
      return unacceptedPendingResponse({
        orderId: params.orderId,
        amountCents: params.amountCents,
        currency: params.currency,
        productId: params.productId,
        providerStatus: params.providerStatus,
        orderAmountCents: params.orderAmountCents,
        settledAmountCents: params.settledAmountCents,
      });
    }
    const winnerBlock = await replayBlockReason(
      params.supabase,
      params.paymentEnvironment,
      winner.order,
    );
    if (winnerBlock) return replayBlockedResponse();
    if (
      winner.order.solidgate_payment_status === '3ds_verify'
      && winner.order.solidgate_verify_url
    ) {
      const winnerVerifyUrl = safeVerifyUrl(winner.order.solidgate_verify_url);
      if (!winnerVerifyUrl) {
        return NextResponse.json(
          { error: 'Stored verification URL is invalid' },
          { status: 502 },
        );
      }
      return NextResponse.json({
        ok: false,
        requiresAction: true,
        verifyUrl: winnerVerifyUrl,
        orderId: params.orderId,
      });
    }
    const winnerAccepted = winner.order.status === 'pending'
      && Boolean(winner.order.solidgate_payment_status)
      && ACCEPTED_PENDING_PROVIDER_STATUSES.has(winner.order.solidgate_payment_status!);
    const winnerCaptured = isDurableCapturedOtoOrder(winner.order, params.productId);
    if (!winnerAccepted && !winnerCaptured) {
      return unacceptedPendingResponse({
        orderId: params.orderId,
        amountCents: params.amountCents,
        currency: params.currency,
        productId: params.productId,
        providerStatus: params.providerStatus,
        orderAmountCents: params.orderAmountCents,
        settledAmountCents: params.settledAmountCents,
      });
    }
    responseProviderStatus = winner.order.solidgate_payment_status!;
    if (winnerCaptured) responseSettledAmount = winner.order.amount_cents;
  }
  const progress = await persistNextOto(
    params.supabase,
    params.paymentEnvironment,
    params.sessionId,
    params.productId,
  );
  return NextResponse.json(
    {
      ok: false,
      pending: true,
      accepted: true,
      orderId: params.orderId,
      amountCents: params.amountCents,
      currency: params.currency,
      productSlug: params.productId,
      ...progress,
      // Keep the legacy key during rollout, but source it from the canonical
      // persisted checkpoint instead of the product requested by this tab.
      nextOto: progress.resumeTo,
      providerStatus: responseProviderStatus,
      ...(params.orderAmountCents !== undefined && {
        orderAmountCents: params.orderAmountCents,
      }),
      ...(responseSettledAmount !== undefined && {
        settledAmountCents: responseSettledAmount,
      }),
    },
    { status: 202 },
  );
}

function unacceptedPendingResponse(params: {
  orderId: string;
  amountCents?: number;
  currency?: string;
  productId?: ProductId;
  providerStatus?: string;
  orderAmountCents?: number;
  settledAmountCents?: number | null;
}) {
  return NextResponse.json(
    {
      ok: false,
      pending: true,
      accepted: false,
      orderId: params.orderId,
      ...(params.amountCents !== undefined && { amountCents: params.amountCents }),
      ...(params.currency && { currency: params.currency }),
      ...(params.productId && { productSlug: params.productId }),
      ...(params.providerStatus && { providerStatus: params.providerStatus }),
      ...(params.orderAmountCents !== undefined && {
        orderAmountCents: params.orderAmountCents,
      }),
      ...(params.settledAmountCents !== undefined && {
        settledAmountCents: params.settledAmountCents,
      }),
    },
    { status: 202 },
  );
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

function replayBlockedResponse() {
  return NextResponse.json(
    { error: 'Purchase is no longer grantable', code: 'grant_revoked' },
    { status: 409 },
  );
}

async function handleObservedProviderOrder(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  paymentEnvironment: PaymentEnvironment;
  sessionId: string;
  productId: ProductId;
  productCode: string;
  bound: BoundOrder;
  orderId: string;
  customerAccountId: string;
  providerOrder: NonNullable<SolidgateOrderStatus['order']>;
  storedVerifyUrl: string | null;
  observedVerifyUrl?: string | null;
  observedVerifyUrlConflict?: boolean;
  expectedAmount: number;
  currency: string;
  locale: Locale;
  userId: string | null;
  claimToken: string | null;
}) {
  const providerStatus = params.providerOrder.status;
  const decision = classifySolidgatePayment(params.providerOrder, params.expectedAmount);

  try {
    assertProviderBinding({
      order: params.providerOrder,
      bound: params.bound,
      orderId: params.orderId,
      customerAccountId: params.customerAccountId,
      productId: params.productId,
      expectedAmount: params.expectedAmount,
      currency: params.currency,
    });
  } catch (error) {
    console.error('[solidgate/charge-oto] observed binding mismatch', {
      orderId: params.orderId,
      error,
    });
    return NextResponse.json(
      { error: 'Provider order does not match this offer', code: 'binding_mismatch' },
      { status: 409 },
    );
  }

  if (decision === 'pending') {
    // A URL observed in this exact provider response is current. A URL loaded
    // from our ledger is reusable only while the provider still says
    // `3ds_verify`; processing/created/auth_ok make an older challenge stale.
    // This path always handles a later `/status` observation. Unlike the
    // immediate `/recurring` response, a status envelope may reuse an old
    // verify_url after authorization moved on. Only explicit `3ds_verify`
    // keeps either observed or stored ACS state actionable.
    const verifyUrl = providerStatus === '3ds_verify' && !params.observedVerifyUrlConflict
      ? safeVerifyUrl(params.observedVerifyUrl ?? undefined)
        ?? safeVerifyUrl(params.storedVerifyUrl ?? undefined)
      : null;
    if (providerStatus && verifyUrl) {
      const persisted = await persistProviderState(
        params.supabase,
        params.paymentEnvironment,
        params.orderId,
        {
          solidgate_payment_status: providerStatus,
          ...(verifyUrl && { solidgate_verify_url: verifyUrl }),
        },
        params.claimToken,
      );
      if (!persisted) return unacceptedPendingResponse({ orderId: params.orderId });

      return NextResponse.json({
        ok: false,
        requiresAction: true,
        verifyUrl,
        orderId: params.orderId,
      });
    }

    if (providerStatus === '3ds_verify') {
      const persisted = await persistProviderState(
        params.supabase,
        params.paymentEnvironment,
        params.orderId,
        {
          solidgate_payment_status: providerStatus,
          ...(params.observedVerifyUrlConflict && { solidgate_verify_url: null }),
        },
        params.claimToken,
      );
      return unacceptedPendingResponse({
        orderId: params.orderId,
        amountCents: params.expectedAmount,
        currency: params.currency,
        productId: params.productId,
        ...(persisted && { providerStatus }),
        orderAmountCents: params.providerOrder.amount,
        settledAmountCents: params.providerOrder.settled_amount,
      });
    }

    if (providerStatus && ACCEPTED_PENDING_PROVIDER_STATUSES.has(providerStatus)) {
      return acceptedPendingResponse({
        supabase: params.supabase,
        paymentEnvironment: params.paymentEnvironment,
        sessionId: params.sessionId,
        productId: params.productId,
        bound: params.bound,
        orderId: params.orderId,
        amountCents: params.expectedAmount,
        currency: params.currency,
        providerStatus,
        claimToken: params.claimToken,
        orderAmountCents: params.providerOrder.amount,
        settledAmountCents: params.providerOrder.settled_amount,
      });
    }

    // `partial_settled` below the bound amount and unknown non-terminal
    // statuses stay on this exact provider identity, but cannot advance.
    const persisted = await persistProviderState(
      params.supabase,
      params.paymentEnvironment,
      params.orderId,
      {
        // Missing provider status is not evidence of `processing`. Persist a
        // non-accepted sentinel so the next retry re-reads `/status` instead
        // of advancing from a value the PSP never reported.
        solidgate_payment_status: providerStatus ?? UNKNOWN_PROVIDER_STATUS,
        solidgate_verify_url: null,
      },
      params.claimToken,
    );
    return unacceptedPendingResponse({
      orderId: params.orderId,
      amountCents: params.expectedAmount,
      currency: params.currency,
      productId: params.productId,
      ...(persisted && providerStatus ? { providerStatus } : {}),
      orderAmountCents: params.providerOrder.amount,
      settledAmountCents: params.providerOrder.settled_amount,
    });
  }

  if (decision !== 'success') {
    if (params.observedVerifyUrlConflict) {
      return NextResponse.json(
        { error: 'Provider returned conflicting payment challenge evidence' },
        { status: 502 },
      );
    }
    const retired = await retireFailedOrder(
      params.supabase,
      params.paymentEnvironment,
      params.orderId,
      providerStatus,
      params.claimToken,
    );
    if (!retired) return unacceptedPendingResponse({ orderId: params.orderId });
    return NextResponse.json(
      {
        error: decision === 'voided'
          ? 'Payment authorization was voided'
          : 'Payment not completed',
        code: decision === 'voided' ? 'void_ok' : undefined,
        status: providerStatus,
      },
      { status: 402 },
    );
  }

  try {
    assertProviderBinding({
      order: params.providerOrder,
      bound: params.bound,
      orderId: params.orderId,
      customerAccountId: params.customerAccountId,
      productId: params.productId,
      expectedAmount: params.expectedAmount,
      currency: params.currency,
      captured: true,
    });
  } catch (error) {
    console.error('[solidgate/charge-oto] settled binding mismatch', {
      orderId: params.orderId,
      error,
    });
    return NextResponse.json(
      { error: 'Provider order does not match this offer', code: 'binding_mismatch' },
      { status: 409 },
    );
  }

  return finalize({
    supabase: params.supabase,
    sessionId: params.sessionId,
    productId: params.productId,
    productCode: params.productCode,
    orderId: params.orderId,
    subscriptionId: params.providerOrder.subscription_id ?? null,
    amount: params.providerOrder.settled_amount
      ?? params.providerOrder.amount
      ?? params.expectedAmount,
    currency: (params.providerOrder.currency ?? params.currency).toLowerCase(),
    userId: params.userId,
    locale: params.locale,
    paymentEnvironment: params.paymentEnvironment,
    providerStatus: providerStatus ?? 'settle_ok',
    claimToken: params.claimToken,
  });
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json()) as {
      sessionId?: unknown;
      slug?: unknown;
      attribution?: unknown;
      returnUrl?: unknown;
      /** Present only when returning from a 3DS redirect. */
      confirmOrderId?: unknown;
    };
    const { sessionId, slug } = body;

    if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }
    if (typeof slug !== 'string' || !OTO_SLUGS.has(slug as ProductId)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 });
    }
    const productId = slug as ProductId;

    const supabase = getSupabaseAdminClient();
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_id, locale, email')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError) {
      return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const access = await authorizeSolidgateSession({
      sessionId,
      sessionUserId: session.user_id ?? null,
    });
    if (!access.ok) return access.response;

    const client = new SolidgateClient(getSolidgateKeys());

    // ── Confirm branch: the buyer is back from a 3DS redirect. Never trust the
    // return itself — re-read the order from Solidgate.
    if (typeof body.confirmOrderId === 'string' && body.confirmOrderId) {
      const orderId = body.confirmOrderId;
      const { data: pendingRaw, error: pendingError } = await supabase
        .from('orders')
        .select(ORDER_GRANT_COLUMNS)
        .eq('payment_environment', paymentEnvironment)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (pendingError) {
        return NextResponse.json({ error: 'Failed to verify purchase state' }, { status: 500 });
      }
      const pending = pendingRaw as BoundOrder | null;
      if (!pending || pending.session_id !== sessionId) {
        return NextResponse.json({ error: 'Order does not belong to this session' }, { status: 403 });
      }
      const initialBlock = await replayBlockReason(supabase, paymentEnvironment, pending);
      if (initialBlock) {
        console.warn('[solidgate/charge-oto] blocked replay', { orderId, reason: initialBlock });
        return replayBlockedResponse();
      }

      // What was sold — including price, currency, identity and metadata — is
      // whatever the immutable pending-order snapshot says was sold.
      const confirmed = boundOtoContext(pending, sessionId);
      if (!confirmed) {
        console.error('[solidgate/charge-oto] confirmation is not bound to an OTO', {
          orderId,
          productCode: pending.product_slug,
        });
        return NextResponse.json(
          { error: 'Order is not bound to this offer', code: 'binding_mismatch' },
          { status: 409 },
        );
      }

      const status = await client.status<SolidgateOrderStatus>({ order_id: orderId });
      const settled = providerOrderFromStatus(status, confirmed.amountCents);
      if (!settled) return unacceptedPendingResponse({ orderId });
      const verifyUrlResolution = resolveSolidgateVerifyUrl(status);
      return handleObservedProviderOrder({
        supabase,
        paymentEnvironment,
        sessionId,
        productId: confirmed.productId,
        productCode: confirmed.productCode,
        bound: pending,
        orderId,
        customerAccountId: access.vault.customerAccountId,
        providerOrder: settled,
        storedVerifyUrl: pending.solidgate_verify_url,
        observedVerifyUrl: verifyUrlResolution.verifyUrl,
        observedVerifyUrlConflict: verifyUrlResolution.conflict,
        expectedAmount: confirmed.amountCents,
        currency: confirmed.currency,
        locale: confirmed.locale,
        userId: access.userId,
        claimToken: null,
      });
    }

    // ── Charge branch.
    const paymentType = paymentTypeForOriginalPaymentMethod(
      access.vault.cardOriginalPaymentMethod,
    );
    if (!paymentType) {
      // Never guess that an unclassified wallet/token is a normal card. Doing
      // so can either violate Solidgate's wallet rules or charge the wrong
      // credential semantics. No provider order has been opened at this point.
      return NextResponse.json(
        { error: 'Saved payment method cannot be reused', code: 'payment_method_unverified' },
        { status: 409 },
      );
    }
    if (
      typeof session.locale !== 'string'
      || !Object.prototype.hasOwnProperty.call(LOCALE_CURRENCY_MAP, session.locale)
    ) {
      return NextResponse.json({ error: 'Session locale missing or unsupported' }, { status: 409 });
    }
    const customerEmail = session.email?.trim().toLowerCase() ?? '';
    if (!customerEmail || !customerEmail.includes('@')) {
      return NextResponse.json({ error: 'Session email missing' }, { status: 409 });
    }
    const locale = session.locale as Locale;
    const currency = LOCALE_CURRENCY_MAP[locale].toLowerCase();
    const productCode = PRODUCT_ID_TO_CODE[productId];
    const attribution = sanitizeAttributionSnapshot(body.attribution);
    const firstTouchUtm = selectFirstTouchUtm(attribution);
    const forwardedIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip')?.trim();
    const ip = forwardedIp || (process.env.VERCEL_ENV === 'production' ? null : '127.0.0.1');
    if (!ip) {
      return NextResponse.json({ error: 'Client IP is unavailable' }, { status: 400 });
    }
    // The browser's same-origin fetch carries its real Accept/User-Agent —
    // forward them as 3DS 2.0 browser data so token charges can go frictionless.
    const headerAccept = request.headers.get('accept') ?? undefined;
    const userAgent = request.headers.get('user-agent') ?? undefined;
    const returnUrl = validatedOtoReturnUrl(request, body.returnUrl);
    if (!returnUrl) {
      return NextResponse.json({ error: 'Invalid OTO return URL' }, { status: 400 });
    }

    const productContext = otoProductContext(productId, locale);
    if (!productContext) {
      return NextResponse.json({ error: 'Missing OTO tracking catalog data' }, { status: 500 });
    }
    const subscriptionCatalogKey = subscriptionOtoCatalogKey(productId);
    const requestedSolidgateProductId = subscriptionCatalogKey
      ? (catalogIds as CatalogIds)[subscriptionCatalogKey]?.product_id ?? null
      : null;
    if (subscriptionCatalogKey && !requestedSolidgateProductId) {
      // catalog-ids.json ships EMPTY in the boilerplate; fail loudly rather
      // than opening a checkout against a product that does not exist.
      return NextResponse.json(
        { error: 'Subscription OTO product not seeded' },
        { status: 500 },
      );
    }
    const orderMetadata = {
      funnel_code: FUNNEL_CODE,
      funnel_variant: productContext.funnel_variant,
      session_id: sessionId,
      product_slug: productId,
      // Subscription initial events need their catalog price UUID. One-time
      // amount-based OTOs truthfully have no price UUID, so keep locale in
      // that slot instead. Both shapes remain within Solidgate's 10-key cap.
      ...(productContext.price_id
        ? { price_id: productContext.price_id }
        : { locale }),
      ...firstTouchUtm,
    };
    const expectedInitialAmount = initialAmount(productId, locale);

    // Opening also leases the single provider submitter. A crashed `creating`
    // row can be taken over only after the lease expires, and that recovery
    // owner must prove the same order is absent at Solidgate before submitting.
    const builderToken = crypto.randomUUID();
    const { data: openedRows, error: openError } = await callOtoRpc<OpenedOtoOrder[]>(
      supabase,
      'open_solidgate_oto_order_v2',
      {
        p_payment_environment: paymentEnvironment,
        p_session_id: sessionId,
        p_product_slug: productCode,
        p_order_prefix: `${sessionId}:${productId}`,
        p_amount_cents: expectedInitialAmount,
        p_currency: currency,
        p_product_name: productCode,
        p_tracking_metadata: orderMetadata,
        p_customer_email: customerEmail,
        p_checkout_locale: locale,
        p_builder_token: builderToken,
        p_user_id: session.user_id,
        p_solidgate_product_id: requestedSolidgateProductId,
        p_solidgate_payment_action: 'auth_settle',
      },
    );
    const opened = openedRows?.[0];
    if (openError) {
      console.error('[solidgate/charge-oto] atomic order binding failed:', openError?.message);
      const conflict = /oto_progress_(?:conflict|environment_mismatch)|oto_step_already_bound|already payable/i.test(
        openError.message,
      );
      if (conflict) {
        return NextResponse.json(
          { error: 'This OTO step is no longer purchasable', code: 'oto_progress_conflict' },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: 'Failed to open charge' }, { status: 500 });
    }
    if (!opened?.solidgate_order_id) {
      return NextResponse.json({ error: 'Failed to open charge' }, { status: 500 });
    }
    const orderId = opened.solidgate_order_id;
    const openedClaimToken = typeof opened.claim_token === 'string'
      ? opened.claim_token
      : null;
    if (
      (opened.should_submit === true || opened.needs_reconcile === true)
      && openedClaimToken !== builderToken
    ) {
      console.error('[solidgate/charge-oto] atomic order lease returned an invalid claim', {
        orderId,
      });
      return NextResponse.json({ error: 'Failed to claim charge' }, { status: 500 });
    }
    returnUrl.searchParams.set('sg_confirm', orderId);

    const { data: boundRaw, error: boundError } = await supabase
      .from('orders')
      .select(ORDER_GRANT_COLUMNS)
      .eq('payment_environment', paymentEnvironment)
      .eq('solidgate_order_id', orderId)
      .maybeSingle();
    const bound = boundRaw as BoundOrder | null;
    const boundContext = bound ? boundOtoContext(bound, sessionId) : null;
    if (
      boundError
      || !bound
      || !boundContext
      || boundContext.productId !== productId
      || !openedBindingMatches(opened, bound, boundContext)
    ) {
      console.error('[solidgate/charge-oto] opened order binding is inconsistent', {
        orderId,
        error: boundError?.message,
      });
      return NextResponse.json(
        { error: 'Order is not bound to this offer', code: 'binding_mismatch' },
        { status: 409 },
      );
    }
    const priorBlock = await replayBlockReason(supabase, paymentEnvironment, bound);
    if (priorBlock) {
      console.warn('[solidgate/charge-oto] blocked replay', { orderId, reason: priorBlock });
      return replayBlockedResponse();
    }
    const boundAmountCents = boundContext.amountCents;
    const boundCurrency = boundContext.currency;
    const boundLocale = boundContext.locale;

    const claimToken = openedClaimToken;
    let shouldSubmit = opened.should_submit === true;

    if (opened.needs_reconcile === true) {
      let recoveredStatus: SolidgateOrderStatus;
      try {
        // This is the one recovery reconciliation. Transport/API failure is
        // indeterminate and must never be mistaken for provider absence.
        recoveredStatus = await client.status<SolidgateOrderStatus>({ order_id: orderId });
      } catch {
        return unacceptedPendingResponse({ orderId });
      }
      const recoveredOrder = providerOrderFromStatus(recoveredStatus, boundAmountCents);
      if (recoveredOrder) {
        const verifyUrlResolution = resolveSolidgateVerifyUrl(recoveredStatus);
        return handleObservedProviderOrder({
          supabase,
          paymentEnvironment,
          sessionId,
          productId,
          productCode,
          bound,
          orderId,
          customerAccountId: access.vault.customerAccountId,
          providerOrder: recoveredOrder,
          storedVerifyUrl: bound.solidgate_verify_url,
          observedVerifyUrl: verifyUrlResolution.verifyUrl,
          observedVerifyUrlConflict: verifyUrlResolution.conflict,
          expectedAmount: boundAmountCents,
          currency: boundCurrency,
          locale: boundLocale,
          userId: access.userId,
          claimToken,
        });
      }
      if (!providerStatusProvesAbsence(recoveredStatus)) {
        // A successful HTTP response without `order` is not absence proof:
        // validation/auth errors use the same envelope. Keep the exact leased
        // identity until Solidgate explicitly says this order does not exist.
        return unacceptedPendingResponse({ orderId });
      }

      const { data: resumed, error: resumeError } = await callOtoRpc<boolean>(
        supabase,
        'resume_solidgate_oto_order_after_absent_reconcile',
        {
          p_payment_environment: paymentEnvironment,
          p_session_id: sessionId,
          p_product_slug: productCode,
          p_order_db_id: opened.order_db_id,
          p_solidgate_order_id: orderId,
          p_builder_token: builderToken,
        },
      );
      if (resumeError || resumed !== true) {
        return unacceptedPendingResponse({ orderId });
      }
      shouldSubmit = true;
    } else if (!shouldSubmit) {
      if (
        bound.solidgate_payment_status === '3ds_verify'
        && bound.solidgate_verify_url
      ) {
        const verifyUrl = safeVerifyUrl(bound.solidgate_verify_url);
        if (!verifyUrl) {
          return NextResponse.json(
            { error: 'Stored verification URL is invalid' },
            { status: 502 },
          );
        }
        return NextResponse.json({
          ok: false,
          requiresAction: true,
          verifyUrl,
          orderId,
        });
      }
      if (
        bound.solidgate_payment_status
        && ACCEPTED_PENDING_PROVIDER_STATUSES.has(bound.solidgate_payment_status)
      ) {
        return acceptedPendingResponse({
          supabase,
          paymentEnvironment,
          sessionId,
          productId,
          bound,
          orderId,
          amountCents: boundAmountCents,
          currency: boundCurrency,
          providerStatus: bound.solidgate_payment_status!,
          claimToken: null,
        });
      }

      // An active creator owns the provider submission. Concurrent callers do
      // not even reconcile until the SQL lease grants recovery ownership.
      if (opened.solidgate_payment_status === 'creating') {
        return unacceptedPendingResponse({ orderId });
      }

      // A provider-visible non-creating order (for example under-captured)
      // may be refreshed, but it is always the same merchant order identity.
      let existingStatus: SolidgateOrderStatus;
      try {
        existingStatus = await client.status<SolidgateOrderStatus>({ order_id: orderId });
      } catch {
        return unacceptedPendingResponse({ orderId });
      }
      const existingOrder = providerOrderFromStatus(existingStatus, boundAmountCents);
      if (!existingOrder) return unacceptedPendingResponse({ orderId });
      const verifyUrlResolution = resolveSolidgateVerifyUrl(existingStatus);
      return handleObservedProviderOrder({
        supabase,
        paymentEnvironment,
        sessionId,
        productId,
        productCode,
        bound,
        orderId,
        customerAccountId: access.vault.customerAccountId,
        providerOrder: existingOrder,
        storedVerifyUrl: bound.solidgate_verify_url,
        observedVerifyUrl: verifyUrlResolution.verifyUrl,
        observedVerifyUrlConflict: verifyUrlResolution.conflict,
        expectedAmount: boundAmountCents,
        currency: boundCurrency,
        locale: boundLocale,
        userId: access.userId,
        claimToken: null,
      });
    }

    if (!shouldSubmit || !claimToken) return unacceptedPendingResponse({ orderId });

    const shared = {
      orderId,
      recurringToken: access.vault.cardToken!,
      paymentType,
      // Data-team grammar: the OTO's code plus o:<the offer it upsold from>.
      orderDescription: solidgateOrderDescription(
        boundLocale,
        productCode,
        SOLIDGATE_PRODUCT_CODES.main,
      ),
      customerAccountId: access.vault.customerAccountId,
      customerEmail: boundContext.customerEmail,
      ipAddress: ip,
      headerAccept,
      userAgent,
      // Solidgate validates success_url and rejects non-https origins with
      // 2.01 "This value is not a valid URL" (verified sandbox 2026-07-17),
      // which kills the whole charge. It is only needed for 3DS returns, so
      // omit it on http (local dev) instead of failing every OTO charge.
      ...(returnUrl.protocol === 'https:' && { successUrl: returnUrl.toString() }),
      metadata: boundContext.metadata,
      // The route owns the lifecycle. Waiting here and then polling again in
      // the browser produced nested ~50 second loops; one accepted provider
      // response is enough to advance while capture remains webhook-owned.
      settlement: { attempts: 0 },
    };

    let result: SolidgateChargeResult;
    try {
      if (isSubscriptionOto(productId)) {
        result = await subscribeSavedCard(client, {
          ...shared,
          productId: boundContext.solidgateProductId!,
          // The shipped subscription OTO opens with a genuine zero-value
          // trial; the recurring amount is due only after the trial period
          // configured on the PSP product.
          expectedAmount: 0,
          currency: boundCurrency,
        });
      } else {
        result = await chargeSavedCard(client, {
          ...shared,
          amount: boundAmountCents,
          currency: boundCurrency,
        });
      }
    } catch (error) {
      // A timeout/network failure after POST /recurring is ambiguous: the PSP
      // may have accepted the charge before its response was lost. Keep the
      // exact order and its submitter lease intact. After expiry the opener
      // reconciles this same ID at /status before it can ever resubmit.
      console.warn('[solidgate/charge-oto] provider submission is indeterminate', {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return unacceptedPendingResponse({ orderId });
    }

    if (result.status === 'requires_action') {
      const verifyUrl = safeVerifyUrl(result.verifyUrl);
      if (!verifyUrl) {
        return NextResponse.json(
          { error: 'Provider returned an invalid verification URL' },
          { status: 502 },
        );
      }
      try {
        assertProviderBinding({
          order: providerOrderFromResult(result),
          bound,
          orderId,
          customerAccountId: access.vault.customerAccountId,
          productId,
          expectedAmount: boundAmountCents,
          currency: boundCurrency,
        });
      } catch (error) {
        console.error('[solidgate/charge-oto] challenge binding mismatch', { orderId, error });
        return NextResponse.json(
          { error: 'Provider order does not match this offer', code: 'binding_mismatch' },
          { status: 409 },
        );
      }
      const persisted = await persistProviderState(
        supabase,
        paymentEnvironment,
        orderId,
        {
          solidgate_payment_status: result.providerStatus ?? '3ds_verify',
          solidgate_verify_url: verifyUrl,
        },
        claimToken,
      );
      if (!persisted) return unacceptedPendingResponse({ orderId });
      // The issuer wants a step-up. The order stays `pending` until the buyer
      // returns through the confirm branch.
      return NextResponse.json({
        ok: false,
        requiresAction: true,
        verifyUrl,
        orderId,
      });
    }

    if (result.status === 'pending') {
      return handleObservedProviderOrder({
        supabase,
        paymentEnvironment,
        sessionId,
        productId,
        productCode,
        bound,
        orderId,
        customerAccountId: access.vault.customerAccountId,
        providerOrder: providerOrderFromResult(result),
        storedVerifyUrl: bound.solidgate_verify_url,
        observedVerifyUrl: result.verifyUrl,
        observedVerifyUrlConflict: result.verifyUrlConflict,
        expectedAmount: boundAmountCents,
        currency: boundCurrency,
        locale: boundLocale,
        userId: access.userId,
        claimToken,
      });
    }

    if (result.status === 'failed' || result.status === 'voided') {
      if (result.verifyUrlConflict) {
        return NextResponse.json(
          { error: 'Provider returned conflicting payment challenge evidence' },
          { status: 502 },
        );
      }
      if (result.providerStatus !== 'request_rejected') {
        try {
          assertProviderBinding({
            order: providerOrderFromResult(result),
            bound,
            orderId,
            customerAccountId: access.vault.customerAccountId,
            productId,
            expectedAmount: boundAmountCents,
            currency: boundCurrency,
          });
        } catch (error) {
          console.error('[solidgate/charge-oto] terminal binding mismatch', { orderId, error });
          return NextResponse.json(
            { error: 'Provider order does not match this offer', code: 'binding_mismatch' },
            { status: 409 },
          );
        }
      }
      const retired = await retireFailedOrder(
        supabase,
        paymentEnvironment,
        orderId,
        result.providerStatus ?? (result.status === 'voided' ? 'void_ok' : 'failed'),
        claimToken,
      );
      if (!retired) return unacceptedPendingResponse({ orderId });
      return NextResponse.json(
        {
          error: result.errorMessage ?? 'Payment declined',
          code: result.errorCode,
          status: result.status === 'voided' ? 'void_ok' : undefined,
        },
        { status: 402 },
      );
    }

    try {
      assertProviderBinding({
        order: providerOrderFromResult(result),
        bound,
        orderId,
        customerAccountId: access.vault.customerAccountId,
        productId,
        expectedAmount: boundAmountCents,
        currency: boundCurrency,
        captured: true,
      });
    } catch (error) {
      console.error('[solidgate/charge-oto] immediate settled binding mismatch', { orderId, error });
      return NextResponse.json(
        { error: 'Provider order does not match this offer', code: 'binding_mismatch' },
        { status: 409 },
      );
    }

    return finalize({
      supabase,
      sessionId,
      productId,
      productCode,
      orderId,
      subscriptionId: result.subscriptionId ?? null,
      amount: boundAmountCents,
      currency: boundCurrency,
      userId: access.userId,
      locale: boundLocale,
      paymentEnvironment,
      providerStatus: result.providerStatus ?? 'settle_ok',
      claimToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[solidgate/charge-oto]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Recognise the money and hand over the goods. */
async function finalize(params: {
  supabase: ReturnType<typeof getSupabaseAdminClient>;
  sessionId: string;
  productId: ProductId;
  productCode: string;
  orderId: string;
  subscriptionId: string | null;
  amount: number;
  currency: string;
  userId: string | null;
  locale: Locale;
  paymentEnvironment: PaymentEnvironment;
  providerStatus: string;
  claimToken: string | null;
}) {
  const {
    supabase, sessionId, productId, productCode, orderId,
    subscriptionId, amount, currency, userId, locale, paymentEnvironment, providerStatus,
    claimToken,
  } = params;

  // This runs for both immediate charges and 3DS confirms. The provider can
  // still say `settle_ok` after a later local refund/cancel/chargeback, so the
  // durable order + entitlement state is checked immediately before writing.
  const { data: currentRawOrder, error: currentOrderError } = await supabase
    .from('orders')
    .select(ORDER_GRANT_COLUMNS)
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  if (currentOrderError) {
    return NextResponse.json({ error: 'Failed to verify purchase state' }, { status: 500 });
  }
  const currentOrder = currentRawOrder as BoundOrder | null;
  const currentContext = currentOrder ? boundOtoContext(currentOrder, sessionId) : null;
  if (
    !currentOrder
    || !currentContext
    || currentContext.productId !== productId
    || currentContext.productCode !== productCode
    || currentContext.amountCents !== amount
    || currentContext.currency !== currency.toLowerCase()
    || currentContext.locale !== locale
    || (currentOrder.user_id && userId && currentOrder.user_id !== userId)
  ) {
    console.error('[solidgate/charge-oto] finalizer binding mismatch', { orderId, productId });
    return NextResponse.json(
      { error: 'Order is not bound to this offer', code: 'binding_mismatch' },
      { status: 409 },
    );
  }
  const tracking = otoTrackingFromBound(currentContext);
  if (!tracking) {
    return NextResponse.json({ error: 'Missing OTO tracking catalog data' }, { status: 500 });
  }
  const currentBlock = await replayBlockReason(supabase, paymentEnvironment, currentOrder);
  if (currentBlock) {
    console.warn('[solidgate/charge-oto] blocked replay', { orderId, reason: currentBlock });
    return replayBlockedResponse();
  }

  let orderUpdate = supabase
    .from('orders')
    .update({
      status: subscriptionId ? 'trialing' : 'completed',
      solidgate_subscription_id: subscriptionId,
      solidgate_payment_status: providerStatus,
      solidgate_verify_url: null,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
      amount_cents: amount,
      currency,
      ...(userId && { user_id: userId, claimed_at: new Date().toISOString() }),
    } as never)
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', orderId)
    .eq('session_id', sessionId)
    .eq('product_slug', currentOrder.product_slug!)
    .eq('amount_cents', currentOrder.amount_cents)
    .eq('currency', currentOrder.currency)
    .eq('solidgate_original_amount_cents', currentContext.amountCents)
    .eq('solidgate_refunded_amount_cents', currentOrder.solidgate_refunded_amount_cents)
    .eq('solidgate_chargeback_amount_cents', currentOrder.solidgate_chargeback_amount_cents)
    // Never rewrite an already-final order (for example a later partial
    // refund's payment status) from a stale browser confirmation. A concurrent
    // identical success is handled by the winner reread below.
    .eq('status', 'pending');
  orderUpdate = currentOrder.solidgate_chargeback_id === null
    ? orderUpdate.is('solidgate_chargeback_id', null)
    : orderUpdate.eq('solidgate_chargeback_id', currentOrder.solidgate_chargeback_id);
  orderUpdate = currentOrder.solidgate_chargeback_status === null
    ? orderUpdate.is('solidgate_chargeback_status', null)
    : orderUpdate.eq('solidgate_chargeback_status', currentOrder.solidgate_chargeback_status);
  orderUpdate = claimToken
    ? orderUpdate.eq('solidgate_submission_token' as never, claimToken as never)
    : orderUpdate.is('solidgate_submission_token' as never, null);
  const { data: order, error: orderUpdateError } = await orderUpdate
    .select('id')
    .maybeSingle();
  let grantOrderId = order?.id ?? null;
  let grantUserId = currentOrder.user_id ?? userId;
  if (orderUpdateError) {
    return NextResponse.json({ error: 'Failed to record purchase' }, { status: 500 });
  }
  if (!grantOrderId) {
    // The signature-verified webhook can complete this exact order and clear
    // our claim between the fresh read and the finalizer CAS. Reuse only that
    // identical durable success; a refund/void/chargeback winner still blocks.
    const winner = await readBoundOrder(supabase, paymentEnvironment, orderId);
    if (winner.error) {
      return NextResponse.json({ error: 'Failed to verify finalized order' }, { status: 500 });
    }
    const winnerBlock = winner.order
      ? await replayBlockReason(supabase, paymentEnvironment, winner.order)
      : 'order_status';
    if (
      !winner.order
      || !sameBoundOtoPurchase({
        candidate: winner.order,
        reference: currentOrder,
        sessionId,
        productId,
        orderId,
        expectedAmount: currentContext.amountCents,
        currency: currentContext.currency,
      })
      || winnerBlock
      || !isDurableCapturedOtoOrder(winner.order, productId)
      || winner.order.solidgate_subscription_id !== subscriptionId
    ) return replayBlockedResponse();
    grantOrderId = winner.order.id;
    grantUserId = winner.order.user_id ?? grantUserId;
  }

  if (grantUserId) {
    // This RPC locks and verifies the captured order and then upserts the
    // entitlement in the same transaction. On same-order browser replay it
    // repairs missing fields but preserves webhook-owned status/expiry.
    const { data: entitlementGranted, error: entitlementError } = await callOtoRpc<boolean>(
      supabase,
      'grant_solidgate_oto_entitlement',
      {
        p_payment_environment: paymentEnvironment,
        p_order_db_id: grantOrderId,
        p_user_id: grantUserId,
        p_product_slug: productCode,
        p_access_level: subscriptionId ? 'trial' : 'full',
        p_expires_at: subscriptionId
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          : null,
        p_solidgate_subscription_id: subscriptionId,
        p_source: 'solidgate_oto',
      },
    );
    if (entitlementError || entitlementGranted !== true) {
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
  }

  // Customer effects are durable and individually idempotent. Enqueueing is
  // part of capture recognition; external cancellation/email happens later in
  // the worker, never on this latency-sensitive request.
  let progress: Awaited<ReturnType<typeof persistNextOto>>;
  try {
    // The lifetime effect cancels the replaced main subscription, so it must
    // never be enqueued before the lifetime entitlement exists — otherwise the
    // resulting cancel webhook would revoke the buyer's ONLY app-access row
    // and lock a paid lifetime buyer out. An anonymous order (session not yet
    // claimed, grantUserId null) defers BOTH grant and effect to the settle
    // webhook, which resolves the user, grants first, and enqueues after.
    if (grantUserId || productId !== 'oto1_lifetime') {
      await enqueueCapturedOtoFulfillment({
        supabase,
        paymentEnvironment,
        solidgateOrderId: orderId,
      });
    }
    progress = await persistNextOto(supabase, paymentEnvironment, sessionId, productId);
  } catch (error) {
    console.error('[solidgate/charge-oto] durable fulfillment enqueue failed', { orderId, error });
    return NextResponse.json({ error: 'Failed to queue purchase fulfillment' }, { status: 500 });
  }

  // Flush the successful charge response before running customer-side effects.
  // The cron remains a recovery path, while this wake-up prevents the newest
  // OTO job (especially lifetime's main-subscription cancellation) from
  // waiting for cron or an unrelated later purchase.
  after(async () => {
    try {
      await drainSolidgateFulfillmentOutbox({ paymentEnvironment, limit: 5 });
    } catch (error) {
      console.error(
        '[solidgate/charge-oto] background fulfillment drain failed:',
        error instanceof Error ? error.message : error,
      );
    }
  });

  return NextResponse.json({
    ok: true,
    orderId,
    subscriptionId,
    amountCents: amount,
    currency: currentContext.currency,
    productSlug: productId,
    tracking,
    ...progress,
    nextOto: progress.resumeTo,
  });
}
