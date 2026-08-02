import type { Database, Json, Tables } from '@repo/shared/types/database';
import type { ProductId } from '@repo/shared/price-map';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import {
  SolidgateClient,
  getSolidgateKeys,
  type PaymentEnvironment,
} from '@repo/shared/solidgate';
import {
  PRODUCT_ID_TO_CODE,
  SOLIDGATE_PRODUCT_CODES,
} from '@repo/shared/solidgate/catalog';
import {
  prepareWelcomeEmail,
  sendPreparedWelcomeEmailDetailed,
  type PreparedWelcomeEmail,
} from '@repo/shared/email/send-welcome-email';
import { sendMetaCapiEvent, hashMetaEmail } from '@/features/analytics/lib/meta-capi';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';
import { purchaseEventId } from '@/features/analytics/lib/checkout-context';
import { enrichPurchasedAccount, type SessionRow } from './provision-account';

type AdminClient = ReturnType<typeof getSupabaseAdminClient>;
type FulfillmentRow = Tables<'solidgate_fulfillment_outbox'>;

const CAPTURED_ORDER_STATUSES = new Set(['completed', 'trialing', 'active']);
const MAIN_ENRICHABLE_ORDER_STATUSES = new Set([
  ...CAPTURED_ORDER_STATUSES,
  // A worker outage must not discard onboarding merely because the first rebill
  // entered its still-grantable grace period before the backlog drained.
  'past_due',
  // OTO1 replaces the recurring plan by canceling its subscription. That is a
  // billing-lifecycle transition, not a refund of the captured main purchase;
  // onboarding/profile work for that buyer must still drain.
  'canceled',
]);
const REVERSED_ORDER_STATUSES = new Set(['failed', 'refunded', 'disputed', 'canceled']);
const MAIN_FINANCIAL_REVERSAL_STATUSES = new Set(['failed', 'refunded', 'disputed']);
const CANCELLED_SUBSCRIPTION_STATUSES = new Set(['cancelled', 'canceled']);
const RESEND_IDEMPOTENCY_SAFETY_MS = 23 * 60 * 60 * 1000;
const EFFECT_TIMEOUT_MS = 20_000;
// Meta rejects website events whose event_time is older than 7 days; stop
// half a day early so a row claimed near the boundary cannot flip mid-flight.
const META_CAPI_EVENT_MAX_AGE_MS = 6.5 * 24 * 60 * 60 * 1000;
// sendMetaCapiEvent returns the same `false` for a revoked token and for a
// transient Graph outage. The cap (~8h at the 21-min backoff ceiling) keeps a
// permanently rejected row from squatting in the oldest-first claim queue and
// starving newer purchases' welcome/profile effects.
const META_CAPI_MAX_ATTEMPTS = 24;

// Must stay in lockstep with the solidgate_fulfillment_outbox.effect_type
// CHECK constraint in the baseline migration. Adding an effect = extend BOTH,
// plus a branch in processEffect(): a row whose effect_type has no handler is
// claimed, fails, and retries forever.
type FulfillmentEffectType =
  | 'cancel_main_subscription'
  | 'send_welcome_email'
  | 'enrich_main_profile'
  | 'send_meta_capi_purchase';

/**
 * The upsell slot that REPLACES the recurring plan: capturing it enqueues a
 * cancellation of the buyer's main subscription. Typed as ProductId so a
 * catalog rename fails the build rather than silently never cancelling.
 *
 * TODO(new product): repoint (or remove the enqueue) if no upsell replaces the
 * subscription.
 */
const REPLACES_MAIN_SUBSCRIPTION_PRODUCT: ProductId = 'oto1_lifetime';

/**
 * Path appended to NEXT_PUBLIC_FUNNEL_URL for the Meta CAPI `event_source_url`
 * when the grant path did not capture the real browser URL. It must be a page
 * that actually exists on the funnel, or Meta drops the event's URL signal.
 */
const CAPI_FALLBACK_EVENT_PATH = 'offer/details';

/**
 * Browser-side attribution captured at grant time so the server-side CAPI
 * Purchase can carry click identity. The webhook enqueue path has no browser
 * request, so every field is optional — email hashing alone still matches.
 */
export interface MetaCapiAttribution {
  fbp?: string;
  fbc?: string;
  client_ip_address?: string;
  client_user_agent?: string;
  event_source_url?: string;
}

const OTO_CODE_TO_PRODUCT = new Map<string, ProductId>(
  Object.entries(PRODUCT_ID_TO_CODE)
    .filter(([productId]) => productId.startsWith('oto'))
    .map(([productId, code]) => [code, productId as ProductId]),
);

export function productIdForOtoCode(code: string | null | undefined): ProductId | null {
  return code ? OTO_CODE_TO_PRODUCT.get(code) ?? null : null;
}

/**
 * Persist every customer-side effect only after capture has been recognised.
 * Repeated API/webhook finalizers upsert the same original-order/effect keys.
 */
export async function enqueueCapturedOtoFulfillment(params: {
  supabase: AdminClient;
  paymentEnvironment: PaymentEnvironment;
  solidgateOrderId: string;
}): Promise<void> {
  const { supabase, paymentEnvironment, solidgateOrderId } = params;
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id,session_id,status,product_slug,solidgate_payment_status,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_checkout_identity_legacy')
    .eq('payment_environment', paymentEnvironment)
    .eq('solidgate_order_id', solidgateOrderId)
    .maybeSingle();
  if (orderError) throw new Error(`fulfillment source order read failed: ${orderError.message}`);
  if (!order?.session_id) throw new Error(`fulfillment source order ${solidgateOrderId} is unbound`);
  if (
    order.solidgate_checkout_identity_legacy
    || !order.solidgate_customer_email
    || !order.solidgate_checkout_locale
  ) {
    throw new Error(`fulfillment source order ${solidgateOrderId} has no immutable checkout identity`);
  }
  const productId = productIdForOtoCode(order.product_slug);
  if (!productId) throw new Error(`fulfillment source order ${solidgateOrderId} is not an OTO`);
  if (!CAPTURED_ORDER_STATUSES.has(order.status)) {
    throw new Error(`fulfillment source order ${solidgateOrderId} is not captured`);
  }
  if (
    REVERSED_ORDER_STATUSES.has(order.status) ||
    order.solidgate_payment_status === 'void_ok' ||
    Boolean(order.solidgate_chargeback_id) ||
    Boolean(order.solidgate_chargeback_status) ||
    (order.solidgate_chargeback_amount_cents ?? 0) > 0
  ) {
    return;
  }

  const effects: Array<{
    environment: PaymentEnvironment;
    solidgate_order_id: string;
    effect_type: FulfillmentEffectType;
    effect_key: string;
    payload: Json;
  }> = [];

  if (productId === REPLACES_MAIN_SUBSCRIPTION_PRODUCT) {
    const { data: subscriptions, error: subscriptionsError } = await supabase
      .from('orders')
      .select('solidgate_subscription_id')
      .eq('payment_environment', paymentEnvironment)
      .eq('session_id', order.session_id)
      .eq('product_slug', SOLIDGATE_PRODUCT_CODES.main)
      .not('solidgate_subscription_id', 'is', null)
      // A still-'pending' paid auth_ok reservation counts: OTO1 is one-click
      // buyable inside the auth_ok→settle window, and its subscription must be
      // replaced exactly like a finalized one — excluding it made this throw
      // (and the charge-oto route 500) for every buyer who bought before the
      // main capture was recognised.
      .or('status.in.(trialing,active,past_due,canceled),and(status.eq.pending,solidgate_payment_status.eq.auth_ok)')
      .order('created_at', { ascending: false });
    if (subscriptionsError) {
      throw new Error(`replacement subscription read failed: ${subscriptionsError.message}`);
    }
    const subscriptionIds = [...new Set(
      (subscriptions ?? [])
        .map((row) => row.solidgate_subscription_id)
        .filter((value): value is string => typeof value === 'string' && Boolean(value)),
    )];
    if (subscriptionIds.length === 0) {
      // Lifetime is offered only after the main subscription. A missing target
      // is an incomplete binding, not a harmless no-op; keep the webhook/job
      // retryable instead of allowing a buyer to be rebilled silently.
      throw new Error(`lifetime order ${solidgateOrderId} has no main subscription to replace`);
    }
    for (const subscriptionId of subscriptionIds) {
      effects.push({
        environment: paymentEnvironment,
        solidgate_order_id: solidgateOrderId,
        effect_type: 'cancel_main_subscription',
        effect_key: `cancel_main_subscription:${subscriptionId}`,
        payload: { subscription_id: subscriptionId },
      });
    }
  }

  if (effects.length === 0) return;
  const { error } = await supabase
    .from('solidgate_fulfillment_outbox')
    .upsert(effects, {
      onConflict: 'environment,solidgate_order_id,effect_key',
      ignoreDuplicates: true,
    });
  if (error) throw new Error(`fulfillment outbox enqueue failed: ${error.message}`);
}

/**
 * Persist slow post-purchase work before the grant response redirects to OTO1.
 * Profile enrichment is idempotent for every linked account; the welcome job
 * is keyed to the captured order so either the grant or webhook may enqueue it
 * safely even when the other path created the auth user first.
 */
export async function enqueueMainPurchaseEnrichment(params: {
  supabase: AdminClient;
  paymentEnvironment: PaymentEnvironment;
  solidgateOrderId: string;
  userId: string;
  sendWelcomeEmail: boolean;
  /** Present only on the grant path — the webhook backstop has no browser. */
  metaAttribution?: MetaCapiAttribution;
}): Promise<void> {
  const {
    supabase,
    paymentEnvironment,
    solidgateOrderId,
    userId,
    sendWelcomeEmail,
    metaAttribution,
  } = params;
  const effects: Array<{
    environment: PaymentEnvironment;
    solidgate_order_id: string;
    effect_type: FulfillmentEffectType;
    effect_key: string;
    payload: Json;
  }> = [
    {
      environment: paymentEnvironment,
      solidgate_order_id: solidgateOrderId,
      effect_type: 'enrich_main_profile',
      effect_key: 'enrich_main_profile',
      payload: { user_id: userId },
    },
  ];
  if (paymentEnvironment === 'production' && sendWelcomeEmail) {
    effects.push({
      environment: paymentEnvironment,
      solidgate_order_id: solidgateOrderId,
      effect_type: 'send_welcome_email',
      effect_key: 'send_welcome_email',
      payload: { user_id: userId },
    });
    // Attribution (fbc/fbp/ip/ua) only exists on the grant path; the stable
    // key means whichever writer commits first pins the payload — the grant
    // usually wins, and the email-only webhook fallback still matches by em.
    effects.push({
      environment: paymentEnvironment,
      solidgate_order_id: solidgateOrderId,
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      payload: {
        user_id: userId,
        ...(metaAttribution?.fbp ? { fbp: metaAttribution.fbp } : {}),
        ...(metaAttribution?.fbc ? { fbc: metaAttribution.fbc } : {}),
        ...(metaAttribution?.client_ip_address
          ? { client_ip_address: metaAttribution.client_ip_address }
          : {}),
        ...(metaAttribution?.client_user_agent
          ? { client_user_agent: metaAttribution.client_user_agent }
          : {}),
        ...(metaAttribution?.event_source_url
          ? { event_source_url: metaAttribution.event_source_url }
          : {}),
      },
    });
  }

  const { error } = await supabase
    .from('solidgate_fulfillment_outbox')
    .upsert(effects, {
      onConflict: 'environment,solidgate_order_id,effect_key',
      ignoreDuplicates: true,
    });
  if (error) throw new Error(`main enrichment outbox enqueue failed: ${error.message}`);
}

interface SubscriptionStatusResponse {
  subscription?: { status?: string };
  status?: string;
  error?: {
    code?: string;
    messages?: string[] | Record<string, string[]>;
    recommended_message_for_user?: string;
  };
}

function providerErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as SubscriptionStatusResponse).error;
  if (!error) return null;
  if (error.recommended_message_for_user) return error.recommended_message_for_user;
  if (Array.isArray(error.messages)) return error.messages[0] ?? error.code ?? 'Solidgate error';
  if (error.messages && typeof error.messages === 'object') {
    return Object.values(error.messages).flat()[0] ?? error.code ?? 'Solidgate error';
  }
  return error.code ?? 'Solidgate error';
}

function subscriptionStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as SubscriptionStatusResponse;
  return response.subscription?.status ?? response.status ?? null;
}

async function verifiedCancelSubscription(
  client: SolidgateClient,
  subscriptionId: string,
  signal: AbortSignal,
  assertOwned: () => Promise<void>,
): Promise<void> {
  let cancellationError: unknown = null;
  let initial: unknown = null;
  try {
    await assertOwned();
    initial = await client.subscriptionStatus({ subscription_id: subscriptionId }, signal);
    const initialError = providerErrorMessage(initial);
    if (initialError) throw new Error(initialError);
    if (CANCELLED_SUBSCRIPTION_STATUSES.has(subscriptionStatus(initial) ?? '')) return;
  } catch (error) {
    if (error instanceof StaleFulfillmentClaimError || signal.aborted) throw error;
    // Status reads can fail transiently. Still attempt the idempotent cancel,
    // then use the mandatory final status read as the source of truth.
    cancellationError = error;
  }

  try {
    await assertOwned();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await client.cancelSubscription({
      subscription_id: subscriptionId,
      force: true,
    }, signal);
    const responseError = providerErrorMessage(response);
    if (responseError) cancellationError = new Error(responseError);
  } catch (error) {
    if (error instanceof StaleFulfillmentClaimError || signal.aborted) throw error;
    // The provider may have applied the cancellation before the response was
    // lost. Do not decide from the transport error; verify below.
    cancellationError = error;
  }

  let final: unknown;
  try {
    await assertOwned();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    final = await client.subscriptionStatus({ subscription_id: subscriptionId }, signal);
  } catch (error) {
    if (error instanceof StaleFulfillmentClaimError || signal.aborted) throw error;
    throw new Error(
      `subscription cancellation could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const finalError = providerErrorMessage(final);
  const finalStatus = subscriptionStatus(final);
  if (!finalError && CANCELLED_SUBSCRIPTION_STATUSES.has(finalStatus ?? '')) return;

  const cause = finalError ?? (
    cancellationError instanceof Error ? cancellationError.message : String(cancellationError ?? '')
  );
  throw new Error(
    `subscription ${subscriptionId} remains ${finalStatus ?? 'unknown'}${cause ? `: ${cause}` : ''}`,
  );
}

async function sourceOrderAllowsEffect(
  supabase: AdminClient,
  row: FulfillmentRow,
): Promise<{
  allowed: boolean;
  orderDbId: string;
  sessionId: string;
  productId: ProductId;
  customerEmail: string;
  checkoutLocale: string;
}> {
  const { data: source, error: sourceError } = await supabase
    .from('orders')
    .select('id,session_id,status,product_slug,solidgate_payment_status,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_checkout_identity_legacy')
    .eq('payment_environment', row.environment)
    .eq('solidgate_order_id', row.solidgate_order_id)
    .maybeSingle();
  if (sourceError) throw new Error(`fulfillment source recheck failed: ${sourceError.message}`);
  if (!source?.session_id) throw new Error('fulfillment source order is missing');
  if (
    source.solidgate_checkout_identity_legacy
    || !source.solidgate_customer_email
    || !source.solidgate_checkout_locale
  ) throw new Error('fulfillment source immutable checkout identity is missing');
  const productId = productIdForOtoCode(source.product_slug);
  if (!productId) throw new Error('fulfillment source product is not an OTO');

  const reversed =
    REVERSED_ORDER_STATUSES.has(source.status) ||
    source.solidgate_payment_status === 'void_ok' ||
    Boolean(source.solidgate_chargeback_id) ||
    Boolean(source.solidgate_chargeback_status) ||
    (source.solidgate_chargeback_amount_cents ?? 0) > 0;
  if (reversed) {
    return {
      allowed: false,
      orderDbId: source.id,
      sessionId: source.session_id,
      productId,
      customerEmail: source.solidgate_customer_email,
      checkoutLocale: source.solidgate_checkout_locale,
    };
  }
  if (!CAPTURED_ORDER_STATUSES.has(source.status)) {
    throw new Error(`fulfillment source order is ${source.status}, not captured`);
  }

  const { data: entitlement, error: entitlementError } = await supabase
    .from('entitlements')
    .select('status,revoked_at')
    .eq('payment_environment', row.environment)
    .eq('order_id', source.id)
    .maybeSingle();
  if (entitlementError) {
    throw new Error(`fulfillment entitlement recheck failed: ${entitlementError.message}`);
  }
  if (entitlement && (entitlement.status === 'canceled' || entitlement.revoked_at)) {
    return {
      allowed: false,
      orderDbId: source.id,
      sessionId: source.session_id,
      productId,
      customerEmail: source.solidgate_customer_email,
      checkoutLocale: source.solidgate_checkout_locale,
    };
  }
  return {
    allowed: true,
    orderDbId: source.id,
    sessionId: source.session_id,
    productId,
    customerEmail: source.solidgate_customer_email,
    checkoutLocale: source.solidgate_checkout_locale,
  };
}

async function mainSourceOrderAllowsEffect(
  supabase: AdminClient,
  row: FulfillmentRow,
): Promise<{
  allowed: boolean;
  orderDbId: string;
  sessionId: string;
  userId: string;
  customerEmail: string;
  checkoutLocale: string;
  amountCents: number;
  currency: string;
  createdAt: string;
}> {
  const { data: source, error: sourceError } = await supabase
    .from('orders')
    .select('id,session_id,user_id,status,product_slug,amount_cents,solidgate_original_amount_cents,currency,created_at,solidgate_payment_status,solidgate_payment_action,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_checkout_identity_legacy')
    .eq('payment_environment', row.environment)
    .eq('solidgate_order_id', row.solidgate_order_id)
    .maybeSingle();
  if (sourceError) throw new Error(`main enrichment source read failed: ${sourceError.message}`);
  if (!source?.session_id || !source.user_id) {
    throw new Error('main enrichment source is not linked to a session and user');
  }
  if (
    source.solidgate_checkout_identity_legacy
    || !source.solidgate_customer_email
    || !source.solidgate_checkout_locale
  ) throw new Error('main enrichment immutable checkout identity is missing');
  if (source.product_slug !== SOLIDGATE_PRODUCT_CODES.main) {
    throw new Error('main enrichment effect is not bound to the main product');
  }

  const reversed =
    MAIN_FINANCIAL_REVERSAL_STATUSES.has(source.status) ||
    (source.solidgate_refunded_amount_cents ?? 0) > 0 ||
    source.solidgate_payment_status === 'void_ok' ||
    Boolean(source.solidgate_chargeback_id) ||
    Boolean(source.solidgate_chargeback_status) ||
    (source.solidgate_chargeback_amount_cents ?? 0) > 0;
  if (reversed) {
    return {
      allowed: false,
      orderDbId: source.id,
      sessionId: source.session_id,
      userId: source.user_id,
      customerEmail: source.solidgate_customer_email,
      checkoutLocale: source.solidgate_checkout_locale,
      amountCents: source.solidgate_original_amount_cents ?? source.amount_cents,
      currency: source.currency,
      createdAt: source.created_at,
    };
  }
  if (!MAIN_ENRICHABLE_ORDER_STATUSES.has(source.status)) {
    throw new Error(`main enrichment source order is ${source.status}, not captured`);
  }
  const captured =
    source.solidgate_payment_status === 'settle_ok' ||
    source.solidgate_payment_status === 'partial_settled' ||
    (
      source.solidgate_payment_status === 'auth_ok' &&
      source.solidgate_payment_action === 'auth_0_amount' &&
      source.solidgate_original_amount_cents === 0 &&
      source.amount_cents === 0
    );
  if (!captured) {
    throw new Error('main enrichment source has no durable capture proof');
  }

  const { data: entitlement, error: entitlementError } = await supabase
    .from('entitlements')
    .select('status,revoked_at,user_id')
    .eq('payment_environment', row.environment)
    .eq('order_id', source.id)
    .maybeSingle();
  if (entitlementError) {
    throw new Error(`main enrichment entitlement read failed: ${entitlementError.message}`);
  }
  if (!entitlement) throw new Error('main enrichment entitlement is not ready');
  if (entitlement.user_id !== source.user_id) {
    return {
      allowed: false,
      orderDbId: source.id,
      sessionId: source.session_id,
      userId: source.user_id,
      customerEmail: source.solidgate_customer_email,
      checkoutLocale: source.solidgate_checkout_locale,
      amountCents: source.solidgate_original_amount_cents ?? source.amount_cents,
      currency: source.currency,
      createdAt: source.created_at,
    };
  }
  return {
    allowed: true,
    orderDbId: source.id,
    sessionId: source.session_id,
    userId: source.user_id,
    customerEmail: source.solidgate_customer_email,
    checkoutLocale: source.solidgate_checkout_locale,
    amountCents: source.solidgate_original_amount_cents ?? source.amount_cents,
    currency: source.currency,
    createdAt: source.created_at,
  };
}

class StaleFulfillmentClaimError extends Error {}
class FulfillmentManualReviewError extends Error {}

function objectPayload(value: Json): Record<string, Json | undefined> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : {};
}

function preparedWelcomePayload(value: Json): {
  message: PreparedWelcomeEmail;
  ambiguousAt: string | null;
} | null {
  const payload = objectPayload(value);
  const rawMessage = payload.prepared_message;
  if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) return null;
  const message = rawMessage as Record<string, Json | undefined>;
  if (
    typeof message.from !== 'string' ||
    typeof message.to !== 'string' ||
    typeof message.subject !== 'string' ||
    typeof message.html !== 'string'
  ) return null;
  return {
    message: {
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
    },
    ambiguousAt: typeof payload.delivery_ambiguous_at === 'string'
      ? payload.delivery_ambiguous_at
      : null,
  };
}

async function fencedOutboxUpdate(
  supabase: AdminClient,
  row: FulfillmentRow,
  values: Database['public']['Tables']['solidgate_fulfillment_outbox']['Update'],
): Promise<boolean> {
  if (!row.claim_token) throw new StaleFulfillmentClaimError('fulfillment claim has no token');
  const { data, error } = await supabase
    .from('solidgate_fulfillment_outbox')
    .update(values)
    .eq('environment', row.environment)
    .eq('id', row.id)
    .eq('status', 'processing')
    .eq('claim_token', row.claim_token)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`fulfillment fenced update failed: ${error.message}`);
  return Boolean(data?.id);
}

async function assertClaimOwned(supabase: AdminClient, row: FulfillmentRow): Promise<void> {
  if (!await fencedOutboxUpdate(supabase, row, { updated_at: new Date().toISOString() })) {
    throw new StaleFulfillmentClaimError('fulfillment lease was reclaimed');
  }
}

async function withEffectTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  effectKey: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error(`fulfillment effect timed out: ${effectKey}`));
          },
          EFFECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processEffect(
  supabase: AdminClient,
  client: SolidgateClient,
  row: FulfillmentRow,
  signal: AbortSignal,
): Promise<void> {
  if (
    row.effect_type === 'send_welcome_email' ||
    row.effect_type === 'enrich_main_profile' ||
    row.effect_type === 'send_meta_capi_purchase'
  ) {
    const source = await mainSourceOrderAllowsEffect(supabase, row);
    // A refund/cancellation which wins before enrichment makes the customer
    // side effect obsolete. Complete the durable row as a fenced no-op.
    if (!source.allowed) return;

    const payload = objectPayload(row.payload);
    if (payload.user_id !== source.userId) {
      throw new Error('main enrichment payload user does not match its source order');
    }
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_id,quiz_answers')
      .eq('id', source.sessionId)
      .maybeSingle();
    if (sessionError) throw new Error(`main enrichment session read failed: ${sessionError.message}`);
    if (!session || session.user_id !== source.userId) {
      throw new Error('main enrichment session user binding changed');
    }
    const checkoutSession: SessionRow = {
      ...session,
      email: source.customerEmail,
      locale: source.checkoutLocale,
    };

    await assertClaimOwned(supabase, row);
    if (row.effect_type === 'enrich_main_profile') {
      await enrichPurchasedAccount({
        supabase,
        sessionId: source.sessionId,
        session: checkoutSession,
        userId: source.userId,
        logPrefix: '[solidgate/fulfillment]',
      });
      return;
    }

    if (row.effect_type === 'send_meta_capi_purchase') {
      if (row.environment !== 'production') return;
      // Bootstrap state: CAPI not (fully) configured — complete as a no-op
      // instead of accumulating failed retries. The sender needs BOTH the
      // token and a pixel id; a token-only config would otherwise loop forever
      // on the sender's unconditional `false`.
      if (
        !process.env.META_CAPI_ACCESS_TOKEN ||
        !(process.env.META_PIXEL_ID ?? process.env.NEXT_PUBLIC_META_PIXEL_ID)
      ) return;
      const sourceCreatedAtMs = Date.parse(source.createdAt);
      if (
        Number.isFinite(sourceCreatedAtMs) &&
        Date.now() - sourceCreatedAtMs > META_CAPI_EVENT_MAX_AGE_MS
      ) {
        // Past Meta's event window the send can only ever be rejected; park it
        // for a human instead of retrying a guaranteed 400 forever.
        throw new FulfillmentManualReviewError(
          'meta capi purchase is beyond the 7-day event window',
        );
      }
      // No hardcoded production host: an unset NEXT_PUBLIC_FUNNEL_URL means we
      // simply omit event_source_url rather than attributing the purchase to
      // someone else's domain.
      const funnelOrigin = (process.env.NEXT_PUBLIC_FUNNEL_URL ?? '').replace(/\/$/, '');
      // Parity with the browser mapping: a €0 authorized trial reports
      // StartTrial, every paid capture reports Purchase. The browser fires the
      // same deterministic purchase:{orderId} id, so Meta collapses the pair
      // whenever the pixel copy also survives.
      const eventName = source.amountCents === 0 ? 'StartTrial' : 'Purchase';
      const delivered = await sendMetaCapiEvent({
        eventName,
        eventId: purchaseEventId(row.solidgate_order_id),
        eventSourceUrl: typeof payload.event_source_url === 'string'
          ? payload.event_source_url
          : funnelOrigin
            ? `${funnelOrigin}/${source.checkoutLocale}/${CAPI_FALLBACK_EVENT_PATH}`
            : undefined,
        // The sender defaults to "now" when the order timestamp is unreadable.
        eventTimeSec: Number.isFinite(sourceCreatedAtMs)
          ? Math.floor(sourceCreatedAtMs / 1000)
          : undefined,
        userData: {
          em: hashMetaEmail(source.customerEmail),
          ...(typeof payload.fbp === 'string' ? { fbp: payload.fbp } : {}),
          ...(typeof payload.fbc === 'string' ? { fbc: payload.fbc } : {}),
          ...(typeof payload.client_ip_address === 'string'
            ? { client_ip_address: payload.client_ip_address }
            : {}),
          ...(typeof payload.client_user_agent === 'string'
            ? { client_user_agent: payload.client_user_agent }
            : {}),
        },
        customData: {
          value: purchaseEventValue(source.amountCents, source.currency),
          currency: source.currency.toUpperCase(),
          content_type: 'product',
        },
      });
      if (!delivered) {
        // sendMetaCapiEvent never throws; false means a transient Graph
        // failure or a revoked token — retry, but only up to the cap, since
        // the two cases are indistinguishable from here.
        if (row.attempts >= META_CAPI_MAX_ATTEMPTS) {
          throw new FulfillmentManualReviewError(
            'meta capi purchase delivery exhausted retries',
          );
        }
        throw new Error('meta capi purchase delivery failed');
      }
      return;
    }

    if (row.environment !== 'production') return;
    const pwaUrl = process.env.NEXT_PUBLIC_PWA_URL;
    if (!pwaUrl) throw new Error('NEXT_PUBLIC_PWA_URL is missing');
    let parsedPwaUrl: URL;
    try {
      parsedPwaUrl = new URL(pwaUrl);
    } catch {
      throw new Error('NEXT_PUBLIC_PWA_URL is invalid');
    }
    if (
      parsedPwaUrl.protocol !== 'https:' ||
      parsedPwaUrl.username ||
      parsedPwaUrl.password
    ) {
      throw new Error('NEXT_PUBLIC_PWA_URL must be credential-free HTTPS');
    }

    let prepared = preparedWelcomePayload(row.payload);
    if (!prepared) {
      const message = prepareWelcomeEmail({
        email: source.customerEmail,
        pwaUrl: parsedPwaUrl.origin,
        locale: source.checkoutLocale,
      });
      prepared = { message, ambiguousAt: null };
      const stablePayload: Json = {
        user_id: source.userId,
        prepared_message: {
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
        },
      };
      if (!await fencedOutboxUpdate(supabase, row, {
        payload: stablePayload,
        updated_at: new Date().toISOString(),
      })) {
        throw new StaleFulfillmentClaimError('welcome preparation lease was reclaimed');
      }
      row.payload = stablePayload;
    }

    const ambiguousAtMs = prepared.ambiguousAt
      ? new Date(prepared.ambiguousAt).getTime()
      : null;
    if (ambiguousAtMs !== null && (
      !Number.isFinite(ambiguousAtMs) ||
      Date.now() - ambiguousAtMs >= RESEND_IDEMPOTENCY_SAFETY_MS
    )) {
      throw new FulfillmentManualReviewError(
        'welcome delivery is beyond the provider idempotency reconciliation window',
      );
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) throw new Error('RESEND_API_KEY is missing');
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const requestStartedAt = prepared.ambiguousAt ?? new Date().toISOString();
    const attemptPayload: Json = {
      user_id: source.userId,
      prepared_message: {
        from: prepared.message.from,
        to: prepared.message.to,
        subject: prepared.message.subject,
        html: prepared.message.html,
      },
      delivery_ambiguous_at: requestStartedAt,
    };
    if (!await fencedOutboxUpdate(supabase, row, {
      payload: attemptPayload,
      updated_at: new Date().toISOString(),
    })) {
      throw new StaleFulfillmentClaimError('welcome send lease was reclaimed');
    }
    row.payload = attemptPayload;

    const delivery = await sendPreparedWelcomeEmailDetailed({
      resendApiKey,
      message: prepared.message,
      idempotencyKey: `welcome:${row.solidgate_order_id}`,
      signal,
    });
    if (delivery.status === 'sent') return;
    if (delivery.status === 'definite_failure' && !prepared.ambiguousAt) {
      const stablePayload: Json = {
        user_id: source.userId,
        prepared_message: {
          from: prepared.message.from,
          to: prepared.message.to,
          subject: prepared.message.subject,
          html: prepared.message.html,
        },
      };
      if (!await fencedOutboxUpdate(supabase, row, {
        payload: stablePayload,
        updated_at: new Date().toISOString(),
      })) {
        throw new StaleFulfillmentClaimError('welcome failure lease was reclaimed');
      }
      row.payload = stablePayload;
    }
    throw new Error(`welcome email delivery failed: ${delivery.error}`);
  }

  const source = await sourceOrderAllowsEffect(supabase, row);
  // A refund/chargeback/void that wins before execution cancels the pending
  // effect permanently. Completing the row as a no-op prevents stale replay.
  if (!source.allowed) return;

  if (row.effect_type === 'cancel_main_subscription') {
    if (source.productId !== REPLACES_MAIN_SUBSCRIPTION_PRODUCT) {
      throw new Error(
        'subscription cancellation effect is not bound to the replacing upsell',
      );
    }
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, Json | undefined>
      : {};
    const subscriptionId = payload.subscription_id;
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      throw new Error('replacement subscription id is missing');
    }
    const { data: mainOrder, error: mainOrderError } = await supabase
      .from('orders')
      .select('id,product_slug,session_id,status')
      .eq('payment_environment', row.environment)
      .eq('solidgate_subscription_id', subscriptionId)
      .maybeSingle();
    if (mainOrderError) throw new Error(`replacement order read failed: ${mainOrderError.message}`);
    if (
      !mainOrder ||
      mainOrder.session_id !== source.sessionId ||
      mainOrder.product_slug !== SOLIDGATE_PRODUCT_CODES.main
    ) {
      throw new Error('replacement subscription is not this session\'s main plan');
    }
    // Never cancel a subscription whose FIRST capture is still being
    // recognised (OTO1 is one-click buyable inside the auth_ok→settle
    // window). Cancelling now would let the provider's cancel callback flip
    // the still-pending opener to 'canceled', after which the late main
    // settle callback is ACKed unrecognised: captured money with no local
    // ledger trail, an unconsumed intro claim, and a closed saved-card gate
    // for OTO2-7. A throw here is a RETRY, not a failure — the outbox
    // backoff absorbs the settle lag and the effect runs once the main order
    // leaves 'pending'.
    if (mainOrder.status === 'pending') {
      throw new Error('replacement subscription main order is still pending capture recognition');
    }

    await verifiedCancelSubscription(
      client,
      subscriptionId,
      signal,
      () => assertClaimOwned(supabase, row),
    );
    await assertClaimOwned(supabase, row);
    const { data: canceledOrder, error: updateError } = await supabase
      .from('orders')
      .update({ status: 'canceled' })
      .eq('payment_environment', row.environment)
      .eq('id', mainOrder.id)
      .eq('solidgate_subscription_id', subscriptionId)
      .select('id')
      .maybeSingle();
    if (updateError) throw new Error(`replacement order cancellation persist failed: ${updateError.message}`);
    if (!canceledOrder?.id) {
      // Supabase updates that match zero rows return error:null. Provider-side
      // cancellation is not enough to complete the outbox: local state is the
      // durable billing ledger and must reflect the same bound subscription.
      throw new Error('replacement order cancellation persist matched no row');
    }
    return;
  }

  throw new Error(`unknown fulfillment effect ${row.effect_type}`);
}

/** Claims quickly, performs external calls outside the claim transaction, and retries each effect independently. */
export async function drainSolidgateFulfillmentOutbox(params?: {
  supabase?: AdminClient;
  client?: SolidgateClient;
  paymentEnvironment?: PaymentEnvironment;
  limit?: number;
}): Promise<{ claimed: number; completed: number; failed: number }> {
  const supabase = params?.supabase ?? getSupabaseAdminClient();
  const paymentEnvironment = params?.paymentEnvironment ?? (
    process.env.VERCEL_ENV === 'production' ? 'production' : 'sandbox'
  );
  const client = params?.client ?? new SolidgateClient(getSolidgateKeys());
  const { data, error } = await supabase.rpc('claim_solidgate_fulfillment_outbox', {
    p_environment: paymentEnvironment,
    p_limit: params?.limit ?? 5,
    p_lease_seconds: 120,
  });
  if (error) throw new Error(`fulfillment outbox claim failed: ${error.message}`);
  const rows = (data ?? []) as FulfillmentRow[];
  let completed = 0;
  let failed = 0;
  const errors: string[] = [];

  await Promise.all(rows.map(async (row) => {
    try {
      await withEffectTimeout(
        (signal) => processEffect(supabase, client, row, signal),
        row.effect_key,
      );
      const completedAt = new Date().toISOString();
      const persisted = await fencedOutboxUpdate(supabase, row, {
        status: 'completed',
        claim_token: null,
        completed_at: completedAt,
        processing_started_at: null,
        last_error: null,
        updated_at: completedAt,
      });
      if (!persisted) return;
      completed += 1;
    } catch (cause) {
      if (cause instanceof StaleFulfillmentClaimError) return;
      failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${row.effect_key}: ${message}`);
      const now = new Date();
      const manualReview = cause instanceof FulfillmentManualReviewError;
      const delaySeconds = Math.min(30 * 60, 5 * 2 ** Math.min(row.attempts, 8));
      try {
        const persisted = await fencedOutboxUpdate(supabase, row, {
          status: manualReview ? 'manual_review' : 'failed',
          claim_token: null,
          processing_started_at: null,
          next_attempt_at: manualReview
            ? row.next_attempt_at
            : new Date(now.getTime() + delaySeconds * 1000).toISOString(),
          last_error: message.slice(0, 2000),
          updated_at: now.toISOString(),
        });
        if (!persisted) return;
      } catch (failureCause) {
        errors.push(
          `failure persist: ${failureCause instanceof Error ? failureCause.message : String(failureCause)}`,
        );
      }
    }
  }));

  if (errors.length > 0) throw new Error(`fulfillment drain failed: ${errors.join('; ')}`);
  return { claimed: rows.length, completed, failed };
}
