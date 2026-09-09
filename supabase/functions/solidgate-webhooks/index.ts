// Supabase Edge Functions intentionally use Deno's npm resolver. The lockfile
// pins the exact transitive versions used at deploy time.
// deno-lint-ignore no-import-prefix
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
// deno-lint-ignore no-import-prefix no-unversioned-import
import { PostHog } from 'npm:posthog-node';
import { verifySolidgateWebhook } from './_signature.ts';
import {
  canonicalProductName,
  isRecurringAddon,
  isLifetime,
  isMainSubscription,
  isOurProduct,
  productToken,
  productTokenFromSlug,
  slugFromCode,
} from './_codes.ts';

/**
 * Solidgate webhooks — the system of record for everything that happens to
 * money after the buyer leaves the page: rebills, dunning, cancellations,
 * refunds, chargebacks, and the settlement of charges that were still
 * `processing` when the API route answered.
 *
 * Differences from the Stripe handler that shape this file:
 *
 *   ONE event multiplexes many. `card_gate.order.updated` covers success,
 *   decline, settle, void and refund — the routing is on `order.status`, not on
 *   an event name. Subscriptions likewise route on `callback_type`.
 *
 *   Delivery is NOT ordered, and duplicates are expected. Every event is
 *   claimed by `solidgate-event-id` before dispatch, and `solidgate-event-
 *   created-at` guards against an older event overwriting a newer state.
 *
 *   The signature covers the RAW body with the WEBHOOK key pair — parsing
 *   first and re-serialising would break every verification.
 *
 * Ack within 30 seconds or Solidgate retries (8 times over ~2 days). A 5xx is
 * therefore a REQUEST to be retried: return it only when a retry could help.
 */

// `Deno` is undefined under vitest, which imports this file to test handleEvent.
// Same guard the Stripe webhook uses.
function env(key: string): string | undefined {
  return typeof Deno !== 'undefined'
    ? Deno.env.get(key)
    : (globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }).process?.env?.[key];
}

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const WEBHOOK_PUBLIC_KEY = env('SOLIDGATE_WEBHOOK_PUBLIC_KEY') ?? '';
const WEBHOOK_SECRET_KEY = env('SOLIDGATE_WEBHOOK_SECRET_KEY') ?? '';
const PWA_URL = env('NEXT_PUBLIC_PWA_URL') ?? '';
const FUNNEL_URL = env('NEXT_PUBLIC_FUNNEL_URL') ?? '';
const INTERNAL_API_SECRET = env('INTERNAL_API_SECRET') ?? '';
const SLACK_DISPUTE_WEBHOOK_URL = env('SLACK_DISPUTE_WEBHOOK_URL') ?? '';

export interface WebhookRuntimeConfig {
  environment: 'production' | 'sandbox';
  webhookPublicKey: string;
  webhookSecretKey: string;
  slackWebhookUrl: string;
  analyticsEnabled: boolean;
  customerSideEffectsEnabled: boolean;
  fulfillmentWorkerUrl: string;
  fulfillmentWorkerSecret: string;
}

let runtime: WebhookRuntimeConfig = {
  environment: 'production',
  webhookPublicKey: WEBHOOK_PUBLIC_KEY,
  webhookSecretKey: WEBHOOK_SECRET_KEY,
  slackWebhookUrl: SLACK_DISPUTE_WEBHOOK_URL,
  analyticsEnabled: true,
  customerSideEffectsEnabled: true,
  fulfillmentWorkerUrl: FUNNEL_URL
    ? `${FUNNEL_URL.replace(/\/$/, '')}/api/internal/solidgate-fulfillment`
    : '',
  fulfillmentWorkerSecret: INTERNAL_API_SECRET,
};

/** Sandbox wrapper configures the shared handler once, before Deno.serve. */
export function configureWebhookRuntime(overrides: Partial<WebhookRuntimeConfig>): void {
  runtime = { ...runtime, ...overrides };
}

/** Access survives a failed rebill for this long while dunning runs. */
const GRACE_PERIOD_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// ── Payload shapes (docs/solidgate/openapi/WEBHOOK-SCHEMAS.md) ──────────────

interface CardOrderTransaction {
  id?: string;
  status?: string;
  operation?: string;
  amount?: number;
  currency?: string;
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
}

interface CardOrderEvent {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    settled_amount?: number | null;
    currency?: string;
    subscription_id?: string;
    customer_account_id?: string;
    customer_email?: string;
    refunded_amount?: number;
    order_description?: string;
    psp_order_id?: string;
    product_id?: string;
    product_name?: string;
    payment_method?: unknown;
  };
  transaction?: CardOrderTransaction;
  transactions?: Record<string, CardOrderTransaction>;
  order_metadata?: Record<string, string>;
  error?: { code?: string; messages?: string[] };
}

interface SubscriptionEvent {
  callback_type?: string;
  subscription?: {
    id?: string;
    status?: string;
    started_at?: string;
    next_charge_at?: string;
    cancelled_at?: string;
    cancel_code?: string;
    cancel_message?: string;
    trial?: boolean;
  };
  product?: { product_id?: string; name?: string; amount?: number; currency?: string };
  customer?: { customer_account_id?: string; customer_email?: string };
  invoices?: Record<
    string,
    {
      id?: string;
      status?: string;
      amount?: number;
      product_price_id?: string;
      created_at?: string;
      updated_at?: string;
      billing_period_started_at?: string;
      billing_period_ended_at?: string;
      subscription_term_number?: number;
      orders?: Record<
        string,
        {
          id?: string;
          status?: string;
          amount?: number;
          operation?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;
      order_metadata?: Record<string, string>;
    }
  >;
}

interface ChargebackEvent {
  order?: {
    order_id?: string;
    amount?: number;
    currency?: string;
  };
  chargeback?: {
    id?: string | number;
    status?: string;
    type?: string;
    amount?: number;
    currency?: string;
    reason_description?: string;
    reason_code?: string;
  };
}

const FAILED_ORDER_STATUSES = new Set(['auth_failed', 'declined']);
const TERMINAL_INITIAL_CARD_FAILURE_STATUSES = new Set([
  ...FAILED_ORDER_STATUSES,
  'void_ok',
]);
const SETTLED_ORDER_STATUSES = new Set(['settle_ok', 'partial_settled']);
const CHARGEBACK_REVERSED_STATUSES = new Set(['reversed', 'resolved_reversal']);
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
// Deployment probe used by the maintenance-cutover runbook. This revision
// requires the token-origin RPCs installed by the version named here.
export const WEBHOOK_CONTRACT_VERSION = '20260722084816';
const WEBHOOK_CONTRACT_HEADER = 'x-solidgate-webhook-contract';

// Immutable catalog product ids used when the merchant order was opened. The
// exact price id is persisted per order in tracking_metadata; together they
// prevent a validly signed callback for one catalog product/currency from
// being rebound to a different local purchase.
// PLACEHOLDER: fill these in with the provider product UUIDs printed by
// `npx tsx scripts/solidgate-seed-catalog.ts --apply`. They are intentionally
// empty in the boilerplate so no real catalog id ships in git. Keys mirror
// packages/shared/src/solidgate/catalog-ids.json.
//
// When you retire and re-create an offer, keep the OLD id listed under a
// `*_archived` key: subscriptions created against the retired generation keep
// emitting events forever, and this map is a recognizer set, never a binder.
const INITIAL_SUBSCRIPTION_PRODUCT_IDS: Record<string, string> = {
  trial1: '',
  trial2: '',
  trial3: '',
  trial4: '',
  special_1eur: '',
  special_free: '',
  addon_trial: '',
  addon_direct: '',
};

export interface WebhookContext {
  eventId?: string;
  eventCreatedAt?: string | null;
  environment?: 'production' | 'sandbox' | string;
}

type PaymentEnvironment = 'production' | 'sandbox';

function paymentEnvironment(context?: WebhookContext): PaymentEnvironment {
  return context?.environment === 'production' || context?.environment === 'sandbox'
    ? context.environment
    : runtime.environment;
}

function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// ── Server-side PostHog outbox ──────────────────────────────────────────────
// Lifecycle events are committed to Postgres before delivery. The deterministic
// insert id lets PostHog deduplicate a retry when the network response was lost.

let _posthog: PostHog | null = null;
function getPostHog(): PostHog | null {
  if (!runtime.analyticsEnabled) return null;
  const key = env('NEXT_PUBLIC_POSTHOG_KEY');
  const host = env('NEXT_PUBLIC_POSTHOG_HOST');
  if (!key || !host) {
    console.warn('[solidgate-webhooks] PostHog key/host not set, skipping analytics');
    return null;
  }
  if (!_posthog) {
    _posthog = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  }
  return _posthog;
}

async function shutdownPostHog(): Promise<void> {
  if (!_posthog) return;
  await _posthog.shutdown();
  _posthog = null;
}

async function deterministicUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ).slice(0, 16);
  // RFC 4122 variant + version 5 shape. The hash is SHA-256 rather than SHA-1,
  // but PostHog only needs a stable UUID-shaped $insert_id, not UUID semantics.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function trackingFunnelVariant(metadata?: Record<string, string>): string | undefined {
  if (metadata?.funnel_variant) return metadata.funnel_variant;
  const tier = metadata?.tier ?? metadata?.product_slug;
  if (!tier) return undefined;
  if (/^trial[1-4]$/.test(tier)) return 'main';
  if (tier === 'special_1eur' || tier === 'special_free') return tier;
  return tier;
}

async function enqueueAnalytics(
  db: SupabaseClient,
  params: {
    eventKey: string;
    eventName: string;
    distinctId: string;
    properties: Record<string, unknown>;
  },
): Promise<void> {
  if (!runtime.analyticsEnabled) return;
  const insertId = await deterministicUuid(`solidgate:${params.eventKey}`);
  const { error } = await db.from('solidgate_analytics_outbox').upsert(
    {
      environment: runtime.environment,
      event_key: params.eventKey,
      event_name: params.eventName,
      distinct_id: params.distinctId,
      insert_id: insertId,
      properties: params.properties,
    },
    { onConflict: 'environment,event_key', ignoreDuplicates: true },
  );
  if (error) throw new Error(`analytics outbox enqueue failed: ${error.message}`);
}

async function enqueueOrderAnalytics(
  db: SupabaseClient,
  params: {
    orderId: string;
    productSlug: string;
    subscriptionId: string | null;
    amountCents: number | null;
    currency: string | null;
    sessionId: string | null;
    userId: string | null;
    email: string | null;
    locale: string | null;
    eventKeySuffix?: string;
    eventName?: string;
    paymentStatus?: string;
    metadata?: Record<string, string>;
    solidgateProductId?: string | null;
    solidgateProductName?: string | null;
    priceId?: string | null;
    refundAmountCents?: number;
    refundedAmountCents?: number;
  },
): Promise<void> {
  const eventName = params.eventName ?? (params.subscriptionId
    ? isRecurringAddon(params.productSlug)
      ? 'oto_subscription_started'
      : 'subscription_started'
    : 'purchase_completed');
  const canonicalProductSlug = params.metadata?.product_slug ?? params.metadata?.tier ??
    slugFromCode(params.productSlug) ?? params.productSlug;
  const productName = canonicalProductName(
    canonicalProductSlug,
    params.solidgateProductName ?? params.metadata?.product_name,
  );
  const revenue = eventName === 'payment_refunded'
    ? -(params.refundAmountCents ?? 0)
    : eventName === 'payment_voided' || eventName === 'payment_failed'
      ? 0
      : params.amountCents;
  await enqueueAnalytics(db, {
    eventKey: `order:${params.orderId}:${params.eventKeySuffix ?? 'settled'}`,
    eventName,
    distinctId: params.sessionId ?? params.userId ?? params.orderId,
    properties: {
      session_id: params.sessionId,
      user_id: params.userId,
      product_slug: canonicalProductSlug,
      product_name: productName,
      product: canonicalProductSlug,
      amount_cents: params.amountCents,
      revenue,
      currency: params.currency?.toUpperCase() ?? null,
      locale: params.locale ?? params.metadata?.locale ?? null,
      solidgate_order_id: params.orderId,
      order_id: params.orderId,
      transaction_id: params.orderId,
      solidgate_subscription_id: params.subscriptionId,
      subscription_id: params.subscriptionId,
      refund_amount_cents: params.refundAmountCents,
      refunded_amount_cents: params.refundedAmountCents,
      payment_status: params.paymentStatus,
      billing_type: params.subscriptionId ? 'subscription_initial' : 'one_time',
      provider: 'solidgate',
      payment_provider: 'solidgate',
      source: 'solidgate_webhook',
      surface: params.sessionId ? 'funnel' : 'pwa',
      app: params.sessionId ? 'funnel' : 'pwa',
      environment: runtime.environment,
      funnel_code: params.metadata?.funnel_code,
      funnel_variant: trackingFunnelVariant(params.metadata),
      tier: params.metadata?.tier ?? params.metadata?.product_slug,
      product_code: params.metadata?.product_code ?? params.productSlug,
      product_id: params.metadata?.product_id ?? params.metadata?.product_code ?? params.productSlug,
      solidgate_product_id: params.solidgateProductId,
      solidgate_product_name: params.solidgateProductName,
      price_id: params.priceId ?? params.metadata?.price_id ?? null,
      solidgate_price_id: params.priceId ?? params.metadata?.price_id ?? null,
      utm_source: params.metadata?.utm_source,
      utm_medium: params.metadata?.utm_medium,
      utm_campaign: params.metadata?.utm_campaign,
      utm_content: params.metadata?.utm_content,
      utm_term: params.metadata?.utm_term,
    },
  });
}

/**
 * Capture recognition only persists lifetime replacement work. Customer-facing
 * cancellation happens in the funnel worker, outside Solidgate's webhook deadline.
 * OTO PDF access is granted in-app through entitlements, so no PDF delivery job
 * belongs in this outbox.
 */
async function enqueueOtoFulfillment(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    orderId: string;
    sessionId: string | null;
    productCode: string;
  },
): Promise<void> {
  const productSlug = slugFromCode(params.productCode);
  if (!productSlug?.startsWith('oto')) return;

  const effects: Array<Record<string, unknown>> = [];
  if (isLifetime(params.productCode)) {
    if (!params.sessionId) {
      throw new Error(`lifetime order ${params.orderId} has no session binding`);
    }
    // A still-'pending' paid auth_ok reservation counts: OTO1 is one-click
    // buyable inside the auth_ok→settle window, so its OTO settle callback
    // can arrive before the main order finalizes — the reservation's
    // subscription must be replaced exactly like a finalized one.
    const { data: candidates, error: candidatesError } = await db
      .from('orders')
      .select('product_slug,solidgate_subscription_id,status,solidgate_payment_status')
      .eq('payment_environment', params.environment)
      .eq('session_id', params.sessionId)
      .in('status', ['trialing', 'active', 'past_due', 'canceled', 'pending']);
    if (candidatesError) {
      throw new Error(`replacement subscription read failed: ${candidatesError.message}`);
    }
    const subscriptionIds = [...new Set(
      (candidates ?? [])
        .filter((row) => isMainSubscription(row.product_slug))
        .filter((row) => row.status !== 'pending' || row.solidgate_payment_status === 'auth_ok')
        .map((row) => row.solidgate_subscription_id)
        .filter((value): value is string => typeof value === 'string' && Boolean(value)),
    )];
    if (subscriptionIds.length === 0) {
      throw new Error(`lifetime order ${params.orderId} has no main subscription to replace`);
    }
    for (const subscriptionId of subscriptionIds) {
      effects.push({
        environment: params.environment,
        solidgate_order_id: params.orderId,
        effect_type: 'cancel_main_subscription',
        effect_key: `cancel_main_subscription:${subscriptionId}`,
        payload: { subscription_id: subscriptionId },
      });
    }
  }

  if (effects.length === 0) return;

  const { error } = await db.from('solidgate_fulfillment_outbox').upsert(effects, {
    onConflict: 'environment,solidgate_order_id,effect_key',
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`fulfillment outbox enqueue failed: ${error.message}`);
}

/**
 * The browser grant and webhook race to backstop the same main-purchase work.
 * Stable per-order keys make either writer safe, while keeping all customer
 * work outside the webhook's response-critical path.
 */
async function enqueueMainPurchaseEnrichment(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    orderId: string;
    userId: string;
    hasEmail: boolean;
  },
): Promise<void> {
  const effects: Array<Record<string, unknown>> = [
    {
      environment: params.environment,
      solidgate_order_id: params.orderId,
      effect_type: 'enrich_main_profile',
      effect_key: 'enrich_main_profile',
      payload: { user_id: params.userId },
    },
  ];
  // Welcome is a per-purchase access email, not a transient "auth user was
  // created in this invocation" effect. This survives a crash after user
  // creation and remains exactly-once at the outbox/provider boundary.
  if (params.environment === 'production' && params.hasEmail) {
    effects.push({
      environment: params.environment,
      solidgate_order_id: params.orderId,
      effect_type: 'send_welcome_email',
      effect_key: 'send_welcome_email',
      payload: { user_id: params.userId },
    });
    // To add another post-purchase effect (CRM sync, fulfilment, ...): push it
    // here with a stable effect_key, extend the effect_type CHECK in
    // supabase/migrations/00001_baseline.sql, and add a handler in
    // apps/funnel/src/lib/payment/solidgate-fulfillment.ts. All three, or the
    // worker claims a row it cannot process.
    //
    // Webhook backstop for the server-side CAPI Purchase: no browser here, so
    // the payload is email-match only. The grant path enqueues the same stable
    // key with fbc/fbp attribution and wins when it commits first.
    effects.push({
      environment: params.environment,
      solidgate_order_id: params.orderId,
      effect_type: 'send_meta_capi_purchase',
      effect_key: 'send_meta_capi_purchase',
      payload: { user_id: params.userId },
    });
  }

  const { error } = await db.from('solidgate_fulfillment_outbox').upsert(effects, {
    onConflict: 'environment,solidgate_order_id,effect_key',
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`main enrichment outbox enqueue failed: ${error.message}`);
}

export async function triggerFunnelFulfillment(): Promise<void> {
  const workerUrl = runtime.fulfillmentWorkerUrl;
  const workerSecret = runtime.fulfillmentWorkerSecret;
  if (!workerUrl || !workerSecret) return;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(workerUrl);
  } catch {
    throw new Error('funnel fulfillment worker URL is invalid');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('funnel fulfillment worker URL must be credential-free HTTPS');
  }
  const response = await fetch(parsedUrl, {
    method: 'POST',
    headers: { 'x-internal-secret': workerSecret },
  });
  if (!response.ok) {
    throw new Error(`funnel fulfillment trigger failed: HTTP ${response.status}`);
  }
}

/**
 * The outbox is already durable before this is called. Waking the funnel
 * worker is therefore latency-only best effort; its cron sweep remains the
 * recovery path if this instance is frozen or the request fails.
 */
function scheduleFunnelFulfillment(): void {
  const task = triggerFunnelFulfillment().catch((error) => {
    console.error(
      '[solidgate-webhooks] background fulfillment trigger failed:',
      error instanceof Error ? error.message : error,
    );
  });
  const edgeRuntime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    try {
      edgeRuntime.waitUntil(task);
      return;
    } catch (error) {
      console.error(
        '[solidgate-webhooks] EdgeRuntime.waitUntil failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
  // Node/vitest and runtimes without waitUntil still start the best-effort
  // promise without placing it on the response's critical path.
  void task;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACQUISITION_UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;
const INTRO_OFFER_TIERS = new Set([
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
  'special_free',
]);

function stringMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (typeof candidate === 'string') result[key] = candidate;
  }
  return result;
}

async function introOfferEmailHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

function introTier(
  orderId: string,
  metadata?: Record<string, string> | null,
): string | null {
  const candidate = metadata?.product_slug ?? metadata?.tier ?? orderId.split(':')[1] ?? null;
  return candidate && INTRO_OFFER_TIERS.has(candidate) ? candidate : null;
}

/** The merchant-wide one-intro invariant must hold before any access grant. */
async function consumeIntroOffer(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    orderId: string;
    productSlug: string;
    sessionId: string | null;
    email: string | null;
    subscriptionId: string | null;
    metadata?: Record<string, string> | null;
  },
): Promise<void> {
  if (!isMainSubscription(params.productSlug)) return;
  const tier = introTier(params.orderId, params.metadata);
  if (!tier || !params.sessionId || !params.email || !params.subscriptionId) {
    throw new Error(`intro subscription ${params.orderId} is missing its merchant claim binding`);
  }
  const { data, error } = await db.rpc('consume_solidgate_intro_offer', {
    p_payment_environment: params.environment,
    p_email_hash: await introOfferEmailHash(params.email),
    p_session_id: params.sessionId,
    p_tier: tier,
    p_subscription_id: params.subscriptionId,
  });
  if (error) throw new Error(`intro offer consumption failed: ${error.message}`);
  if (data === 'consumed') return;

  // The ledger did not expect this subscription. Three shapes, and they are NOT
  // equally serious, so they are reported apart: `reassigned` is a single
  // subscription whose claim had been re-keyed (nothing owed), `superseded` is a
  // real second charge, anything else is unrecognised and unsafe to interpret.
  const recoverable = data === 'superseded' || data === 'reassigned';
  await enqueueAnalytics(db, {
    eventKey: `intro-offer-conflict:${params.environment}:${params.orderId}:${params.subscriptionId}`,
    eventName: 'intro_offer_conflict',
    distinctId: params.sessionId ?? params.orderId,
    properties: {
      provider: 'solidgate',
      environment: params.environment,
      session_id: params.sessionId,
      solidgate_order_id: params.orderId,
      solidgate_subscription_id: params.subscriptionId,
      product_code: params.productSlug,
      tier,
      source: 'solidgate_webhook',
      resolution: data === 'superseded'
        ? 'granted_needs_refund'
        : data === 'reassigned'
          ? 'granted_reassigned'
          : 'aborted',
    },
  });

  // Both recoverable outcomes must continue to the grant: the money moved.
  // Throwing here — as this did for every non-'consumed' result — aborted the
  // whole handler, so Solidgate retried forever and the paying customer never
  // got an account at all.
  if (!recoverable) {
    throw new Error(
      `intro offer conflict for ${params.orderId}/${params.subscriptionId}: ${String(data)}`,
    );
  }
}

/**
 * Funnel session IDs were intentionally identified before auth, so PostHog's
 * regular alias safeguard rejects them as aliases. Once our payment ledger
 * proves that a session belongs to an auth UUID, queue the documented recovery
 * merge with the stable user UUID as the survivor. The environment-scoped key
 * makes this irreversible operation exactly-once from our side.
 */
async function enqueueIdentityMerge(
  db: SupabaseClient,
  userId: string | null,
  sessionId: string | null,
): Promise<void> {
  if (!userId || !sessionId || userId === sessionId) return;
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(sessionId)) return;
  await enqueueAnalytics(db, {
    eventKey: `identity:${runtime.environment}:${userId}:${sessionId}`,
    eventName: '$merge_dangerously',
    distinctId: userId,
    properties: {
      alias: sessionId,
      user_id: userId,
      session_id: sessionId,
      source: 'solidgate_account_link',
      environment: runtime.environment,
    },
  });
}

/** First successful linked order wins account attribution; later visits never overwrite it. */
async function persistAccountAcquisition(
  db: SupabaseClient,
  params: {
    userId: string | null;
    sessionId: string | null;
    orderRowId: string;
    capturedAt: string;
    environment: PaymentEnvironment;
    metadata?: Record<string, string>;
  },
): Promise<void> {
  if (!params.userId || !params.sessionId || !params.metadata) return;
  if (!UUID_PATTERN.test(params.userId) || !UUID_PATTERN.test(params.sessionId)) return;
  const utm: Record<string, string> = {};
  for (const key of ACQUISITION_UTM_KEYS) {
    const value = params.metadata[key]?.trim().slice(0, 380);
    if (value) utm[key] = value;
  }
  if (Object.keys(utm).length === 0) return;
  const { error } = await db.rpc('persist_user_acquisition_attribution', {
    p_payment_environment: params.environment,
    p_user_id: params.userId,
    p_source_session_id: params.sessionId,
    p_source_order_id: params.orderRowId,
    p_captured_at: params.capturedAt,
    p_utm_source: utm.utm_source ?? null,
    p_utm_medium: utm.utm_medium ?? null,
    p_utm_campaign: utm.utm_campaign ?? null,
    p_utm_content: utm.utm_content ?? null,
    p_utm_term: utm.utm_term ?? null,
  });
  if (error) throw new Error(`account acquisition persist failed: ${error.message}`);
}

interface AnalyticsOutboxRow {
  id: string;
  event_name: string;
  distinct_id: string;
  insert_id: string;
  properties: Record<string, unknown>;
  attempts: number;
  created_at: string;
}

export async function drainAnalyticsOutbox(db: SupabaseClient): Promise<void> {
  const posthog = getPostHog();
  if (!posthog) return;

  const { data, error } = await db.rpc('claim_solidgate_analytics_outbox', {
    p_environment: runtime.environment,
    p_limit: 25,
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`analytics outbox claim failed: ${error.message}`);
  const rows = (data ?? []) as AnalyticsOutboxRow[];
  if (rows.length === 0) {
    await shutdownPostHog();
    return;
  }

  try {
    for (const row of rows) {
      posthog.capture({
        distinctId: row.distinct_id,
        event: row.event_name,
        uuid: row.insert_id,
        // PostHog's ingestion dedupe key also contains the event timestamp.
        // Reuse the persisted outbox timestamp so a retry after an ambiguous
        // network response cannot become a second revenue event.
        timestamp: new Date(row.created_at),
        properties: { ...row.properties, $insert_id: row.insert_id },
      });
    }
    await shutdownPostHog();
    const completedAt = new Date().toISOString();
    for (const row of rows) {
      const { error: updateError } = await db
        .from('solidgate_analytics_outbox')
        .update({
          status: 'completed',
          completed_at: completedAt,
          processing_started_at: null,
          updated_at: completedAt,
        })
        .eq('environment', runtime.environment)
        .eq('id', row.id);
      if (updateError) throw new Error(`analytics outbox completion failed: ${updateError.message}`);
      const orderId = row.properties?.solidgate_order_id;
      if (typeof orderId === 'string') {
        const { error: orderMarkerError } = await db.from('orders').update({ analytics_captured_at: completedAt })
          .eq('payment_environment', runtime.environment)
          .eq('solidgate_order_id', orderId).is('analytics_captured_at', null);
        if (orderMarkerError) {
          throw new Error(`order analytics marker failed: ${orderMarkerError.message}`);
        }
      }
    }
  } catch (err) {
    _posthog = null;
    const message = err instanceof Error ? err.message : String(err);
    let failureWriteError: string | null = null;
    for (const row of rows) {
      const retryAt = new Date().toISOString();
      const { error: updateError } = await db
        .from('solidgate_analytics_outbox')
        .update({
          status: 'failed',
          processing_started_at: null,
          // Keep it immediately claimable: the thrown error asks Solidgate to
          // redeliver this webhook, which must be able to drain the row even
          // when there is no other payment traffic.
          next_attempt_at: retryAt,
          last_error: message.slice(0, 2000),
          updated_at: retryAt,
        })
        .eq('environment', runtime.environment)
        .eq('id', row.id);
      if (updateError && !failureWriteError) {
        failureWriteError = updateError.message;
      }
    }
    console.error('[solidgate-webhooks] analytics outbox delivery failed:', message);
    if (failureWriteError) {
      throw new Error(
        `analytics outbox delivery failed: ${message}; failure persist failed: ${failureWriteError}`,
      );
    }
    throw new Error(`analytics outbox delivery failed: ${message}`);
  }
}

// ── Durable inbox + ordering ────────────────────────────────────────────────

type WebhookClaimState = 'claimed' | 'completed' | 'busy';

interface WebhookClaim {
  state: WebhookClaimState;
  token: string | null;
  generation: number;
}

async function claimEvent(
  db: SupabaseClient,
  eventId: string,
  type: string,
  createdAt: string | null,
  environment: string,
  payload: unknown,
): Promise<WebhookClaim> {
  const { data, error } = await db.rpc('claim_solidgate_webhook_event_v2', {
    p_event_id: eventId,
    p_type: type,
    p_event_created_at: createdAt,
    p_environment: environment,
    p_payload: payload,
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`webhook inbox claim failed: ${error.message}`);
  const result = (Array.isArray(data) ? data[0] : data) as {
    claim_state?: unknown;
    claim_token?: unknown;
    claim_generation?: unknown;
  } | null;
  const state = result?.claim_state;
  const token = result?.claim_token;
  const generation = result?.claim_generation;
  if (
    (state !== 'claimed' && state !== 'completed' && state !== 'busy')
    || !Number.isSafeInteger(generation)
    || (generation as number) < 0
    || (
      state === 'claimed'
      && (typeof token !== 'string' || !UUID_PATTERN.test(token) || (generation as number) < 1)
    )
  ) {
    throw new Error(`webhook inbox claim returned invalid state: ${JSON.stringify(data)}`);
  }
  return {
    state,
    token: state === 'claimed' ? token as string : null,
    generation: generation as number,
  };
}

async function completeEvent(
  db: SupabaseClient,
  eventId: string,
  environment: PaymentEnvironment,
  claim: WebhookClaim,
): Promise<void> {
  if (!claim.token || claim.state !== 'claimed') {
    throw new Error(`webhook inbox completion failed: event ${eventId} has no claim`);
  }
  const { data, error } = await db.rpc('complete_solidgate_webhook_event_v2', {
    p_environment: environment,
    p_event_id: eventId,
    p_claim_token: claim.token,
    p_claim_generation: claim.generation,
  });
  if (error) throw new Error(`webhook inbox completion failed: ${error.message}`);
  if (data !== true) {
    throw new Error(`webhook inbox completion failed: event ${eventId} claim is stale`);
  }
}

async function failEvent(
  db: SupabaseClient,
  eventId: string,
  environment: PaymentEnvironment,
  claim: WebhookClaim,
  message: string,
): Promise<void> {
  if (!claim.token || claim.state !== 'claimed') {
    throw new Error(`webhook inbox failure persist failed: event ${eventId} has no claim`);
  }
  const { data, error } = await db.rpc('fail_solidgate_webhook_event_v2', {
    p_environment: environment,
    p_event_id: eventId,
    p_claim_token: claim.token,
    p_claim_generation: claim.generation,
    p_last_error: message.slice(0, 4000),
  });
  if (error) throw new Error(`webhook inbox failure persist failed: ${error.message}`);
  if (data !== true) {
    throw new Error(`webhook inbox failure persist failed: event ${eventId} claim is stale`);
  }
}

async function withEntityOrdering(
  db: SupabaseClient,
  context: WebhookContext | undefined,
  entityType: 'payment' | 'subscription',
  entityId: string,
  handler: () => Promise<void>,
): Promise<void> {
  if (!context?.eventId || !context.eventCreatedAt) {
    await handler();
    return;
  }

  const orderedEntityId = `${context.environment ?? runtime.environment}:${entityId}`;
  const args = {
    p_entity_type: entityType,
    p_entity_id: orderedEntityId,
    p_event_created_at: context.eventCreatedAt,
    p_event_id: context.eventId,
    p_lease_seconds: 300,
  };
  // Solidgate fires the auth and settle events for one order within the same
  // second, so "busy" is the COMMON case, not a rare race. Waiting out the
  // sibling in-process turns a failed-event-plus-redelivery cycle (Solidgate
  // may take minutes-to-hours to retry, leaving paid orders stuck 'pending')
  // into a few seconds of latency.
  let data: unknown;
  for (let attempt = 0; ; attempt++) {
    const { data: claim, error } = await db.rpc('claim_solidgate_entity_event', args);
    if (error) throw new Error(`entity ordering claim failed: ${error.message}`);
    data = claim;
    if (data !== 'busy' || attempt >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (data === 'stale') {
    console.log('[solidgate-webhooks] stale event ignored', { entityType, entityId: orderedEntityId, eventId: context.eventId });
    return;
  }
  if (data !== 'claimed') throw new Error(`entity ${entityType}:${entityId} is busy`);

  try {
    await handler();
    const { error: completeError } = await db.rpc('complete_solidgate_entity_event', {
      p_entity_type: entityType,
      p_entity_id: orderedEntityId,
      p_event_created_at: context.eventCreatedAt,
      p_event_id: context.eventId,
    });
    if (completeError) throw new Error(`entity ordering completion failed: ${completeError.message}`);
  } catch (err) {
    const { error: releaseError } = await db.rpc('release_solidgate_entity_event', {
      p_entity_type: entityType,
      p_entity_id: orderedEntityId,
      p_event_id: context.eventId,
    });
    if (releaseError) {
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(`entity ordering release failed: ${releaseError.message}; original error: ${original}`);
    }
    throw err;
  }
}

// ── Shared side effects ─────────────────────────────────────────────────────

/**
 * Initial Solidgate access is granted by flow-specific database functions
 * that lock and revalidate the captured source order. A generic entitlement
 * upsert cannot safely arbitrate a reversal race or a late older purchase.
 */
async function grantInitialSolidgateEntitlement(
  db: SupabaseClient,
  params: {
    row: InitialOrderBindingRow;
    userId: string;
    subscriptionId: string | null;
    expiresAt: string | null;
    environment: PaymentEnvironment;
    pwaDirectSubscription: boolean;
  },
): Promise<boolean> {
  let result: { data: unknown; error: { message: string } | null };
  if (isMainSubscription(params.row.product_slug)) {
    if (!params.subscriptionId || !params.expiresAt) {
      throw new Error('main entitlement grant is missing its subscription period');
    }
    result = await db.rpc('grant_solidgate_main_entitlement', {
      p_payment_environment: params.environment,
      p_order_id: params.row.id,
      p_user_id: params.userId,
      p_product_slug: params.row.product_slug,
      p_subscription_id: params.subscriptionId,
      p_amount_cents: params.row.solidgate_original_amount_cents ?? params.row.amount_cents,
      p_fallback_expires_at: params.expiresAt,
    });
  } else if (params.row.session_id) {
    result = await db.rpc('grant_solidgate_oto_entitlement', {
      p_payment_environment: params.environment,
      p_order_db_id: params.row.id,
      p_user_id: params.userId,
      p_product_slug: params.row.product_slug,
      p_access_level: params.subscriptionId ? 'trial' : 'full',
      p_expires_at: params.subscriptionId ? params.expiresAt : null,
      p_solidgate_subscription_id: params.subscriptionId,
      p_source: 'solidgate_webhook',
    });
  } else {
    result = await db.rpc('grant_solidgate_pwa_entitlement', {
      p_payment_environment: params.environment,
      p_order_db_id: params.row.id,
      p_user_id: params.userId,
      p_product_slug: params.row.product_slug,
      p_access_level: 'full',
      p_expires_at: params.pwaDirectSubscription ? params.expiresAt : null,
      p_solidgate_subscription_id: params.subscriptionId,
      p_source: 'solidgate_webhook',
    });
  }
  if (result.error) {
    throw new Error(`atomic Solidgate entitlement grant failed: ${result.error.message}`);
  }
  if (result.data === true) return true;

  // FALSE is intentionally used for safe arbitration losses. Classify it
  // from durable state so a delayed older payment or a same-order lifecycle
  // tombstone is ACKed without access, while an unexplained invariant failure
  // remains retryable and visible.
  const { data: durableOrder, error: durableOrderError } = await db.from('orders')
    .select('id,status,solidgate_payment_status,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents')
    .eq('payment_environment', params.environment)
    .eq('id', params.row.id)
    .maybeSingle();
  if (durableOrderError) {
    throw new Error(`atomic Solidgate grant classification failed: ${durableOrderError.message}`);
  }
  if (durableOrder && terminalOrderPreventsGrant(durableOrder)) return false;

  const { data: entitlement, error: entitlementError } = await db.from('entitlements')
    .select('order_id,status,revoked_at')
    .eq('payment_environment', params.environment)
    .eq('user_id', params.userId)
    .eq('product_slug', params.row.product_slug)
    .maybeSingle();
  if (entitlementError) {
    throw new Error(`atomic Solidgate entitlement classification failed: ${entitlementError.message}`);
  }
  if (entitlement?.order_id === params.row.id) return false;
  if (entitlement?.order_id) {
    const { data: owner, error: ownerError } = await db.from('orders')
      .select('id,created_at')
      .eq('id', entitlement.order_id)
      .maybeSingle();
    if (ownerError) {
      throw new Error(`atomic Solidgate entitlement owner read failed: ${ownerError.message}`);
    }
    if (owner) {
      const ownerAt = new Date(owner.created_at).getTime();
      const sourceAt = new Date(params.row.created_at).getTime();
      if (
        ownerAt > sourceAt
        || (ownerAt === sourceAt && owner.id.localeCompare(params.row.id) >= 0)
      ) return false;
    }
  }
  throw new Error('atomic Solidgate entitlement grant rejected an unclassified captured order');
}

async function applySolidgateSubscriptionLifecycle(
  db: SupabaseClient,
  params: {
    row: SubscriptionOrderRow;
    userId: string;
    subscriptionId: string;
    accessLevel: 'full' | 'trial' | 'grace';
    status: 'active' | 'past_due';
    expiresAt: string | null;
    source: string;
    environment: PaymentEnvironment;
  },
): Promise<boolean> {
  const { data, error } = await db.rpc(
    'apply_solidgate_subscription_entitlement_lifecycle',
    {
      p_payment_environment: params.environment,
      p_order_db_id: params.row.id,
      p_user_id: params.userId,
      p_product_slug: params.row.product_slug,
      p_solidgate_subscription_id: params.subscriptionId,
      p_access_level: params.accessLevel,
      p_status: params.status,
      p_expires_at: params.expiresAt,
      p_source: params.source,
    },
  );
  if (error) throw new Error(`atomic subscription lifecycle failed: ${error.message}`);
  if (data === 'applied') return true;
  if (data === 'stale' || data === 'lifecycle_owned' || data === 'reversed') return false;
  throw new Error(`atomic subscription lifecycle rejected binding: ${String(data)}`);
}

type DurableGrantOrderState = {
  id: string;
  status?: string | null;
  solidgate_payment_status?: string | null;
  solidgate_refunded_amount_cents?: number | null;
  solidgate_chargeback_id?: string | null;
  solidgate_chargeback_status?: string | null;
  solidgate_chargeback_amount_cents?: number | null;
};

/** Local terminal state always outranks a later positive provider callback. */
function terminalOrderPreventsGrant(row: DurableGrantOrderState): boolean {
  return (
    row.status === 'canceled' ||
    row.status === 'refunded' ||
    row.status === 'disputed' ||
    row.solidgate_payment_status === 'void_ok' ||
    Boolean(row.solidgate_chargeback_id) ||
    Boolean(row.solidgate_chargeback_status) ||
    (row.solidgate_chargeback_amount_cents ?? 0) > 0
  );
}

async function originalEntitlementWasRevoked(
  db: SupabaseClient,
  orderId: string,
  environment: PaymentEnvironment,
): Promise<boolean> {
  const { data, error } = await db
    .from('entitlements')
    .select('status,revoked_at')
    .eq('payment_environment', environment)
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw new Error(`entitlement replay guard failed: ${error.message}`);
  return Boolean(data && (data.status === 'canceled' || data.revoked_at));
}

/**
 * Revoke by the entitlement's immutable source order, not by an ownership
 * snapshot read before a concurrent browser grant. The terminal order UPDATE
 * serializes with the atomic grant RPC on the same order row: either the grant
 * commits first and this update removes it, or the terminal state commits
 * first and the grant RPC rejects it.
 */
async function revokeInitialOrderEntitlement(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    orderId: string;
    reason: 'refund' | 'void' | 'chargeback';
  },
): Promise<void> {
  const { error } = await db.from('entitlements')
    .update({ status: 'canceled', revoked_at: new Date().toISOString() })
    .eq('payment_environment', params.environment)
    .eq('order_id', params.orderId);
  if (error) {
    throw new Error(`${params.reason} entitlement revoke failed: ${error.message}`);
  }
}

async function revokeBySubscription(
  db: SupabaseClient,
  subscriptionId: string,
  environment: PaymentEnvironment,
): Promise<void> {
  const { error } = await db
    .from('entitlements')
    .update({ status: 'canceled', revoked_at: new Date().toISOString() })
    .eq('payment_environment', environment)
    .eq('solidgate_subscription_id', subscriptionId);
  if (error) throw new Error(`entitlement revoke failed: ${error.message}`);
}

/** Member-area access: the main subscription or its lifetime replacement. */
function entitlementGrantsAppAccess(productSlug: string | null | undefined): boolean {
  if (isMainSubscription(productSlug) || isLifetime(productSlug)) return true;
  const token = productTokenFromSlug(productSlug ?? null);
  return isMainSubscription(token) || isLifetime(token);
}

/**
 * Solidgate UAT item 8: a hard cancel must end the session NOW, not at token
 * expiry. GoTrue has no admin logout-by-user-id endpoint (admin.signOut needs
 * the user's own JWT), so revocation happens at the source of truth: the
 * revoke_user_auth_sessions RPC (migration 20260728093000) deletes the user's
 * auth sessions + refresh tokens. Best-effort by design: session revocation is
 * not payment truth, and its failure must never fail (or retry) the webhook —
 * the PWA (app) layout re-checks entitlements per request either way.
 */
async function revokeAuthSessions(db: SupabaseClient, userId: string): Promise<void> {
  try {
    const { error } = await db.rpc('revoke_user_auth_sessions', { p_user_id: userId });
    if (error) {
      console.error('[solidgate-webhooks] session revocation failed:', error.message);
    }
  } catch (err) {
    console.error('[solidgate-webhooks] session revocation failed:', err);
  }
}

/**
 * After a cancel/expire: sign the user out unless app access remains. Mirrors
 * appAccessEntitlementState in packages/shared/src/entitlements.ts — sign out
 * only when the NEWEST app-access row is an explicit tombstone. A merely
 * lapsed expires_at is the renewal boundary (expiry is written as the
 * provider's next_charge_at with zero slack), and the lifetime-replacement
 * flow's ordering guarantees (grant before cancel enqueue) keep the lifetime
 * row visible here before its main-subscription cancel is processed.
 */
async function endSessionsWithoutAppAccess(
  db: SupabaseClient,
  userId: string,
  environment: PaymentEnvironment,
): Promise<void> {
  const { data: rows, error } = await db
    .from('entitlements')
    .select('product_slug,status,access_level,revoked_at,expires_at,granted_at')
    .eq('payment_environment', environment)
    .eq('user_id', userId);
  if (error) {
    // Fail open (skip the logout), never the webhook: the per-request layout
    // gate still locks the member area on the next navigation.
    console.error('[solidgate-webhooks] post-cancel access read failed:', error.message);
    return;
  }
  const appRows = (rows ?? []).filter((row) => entitlementGrantsAppAccess(row.product_slug));
  if (appRows.length === 0) return;
  const now = Date.now();
  const stillHasAppAccess = appRows.some((row) =>
    row.revoked_at == null &&
    (row.status === 'active' || (row.status === 'past_due' && row.access_level === 'grace')) &&
    (row.expires_at == null || Date.parse(row.expires_at) > now)
  );
  if (stillHasAppAccess) return;
  const newest = appRows.reduce((a, b) =>
    (Date.parse(a.granted_at ?? '') || 0) >= (Date.parse(b.granted_at ?? '') || 0) ? a : b
  );
  if (newest.revoked_at != null || newest.status === 'canceled') {
    await revokeAuthSessions(db, userId);
  }
}

/**
 * Webhook backstop for the normal grant/OTP promotion path. If the browser
 * disappears after payment, the account must still inherit the session card
 * before the Edge Function acknowledges the event.
 */
async function promoteSessionCardToAccount(
  db: SupabaseClient,
  params: {
    userId: string;
    sessionId: string;
    paymentEnvironment: PaymentEnvironment;
  },
): Promise<void> {
  const { data, error } = await db.rpc('promote_solidgate_session_vault_with_method', {
    p_payment_environment: params.paymentEnvironment,
    p_user_id: params.userId,
    p_session_id: params.sessionId,
  });
  if (error) throw new Error(`account vault promotion failed: ${error.message}`);
  if (!['written', 'same', 'stale'].includes(String(data))) {
    throw new Error(`account vault promotion returned ${String(data)}`);
  }
}

/**
 * Resolves the buyer's auth user, creating it if the grant route never ran (it
 * can fail, or the buyer can close the tab the instant the form succeeds). This
 * is what makes the webhook a real backstop rather than a bookkeeper: without
 * it a paid order whose grant call died leaves a customer with no account.
 *
 * Returns null when there is nothing to work with.
 */
async function resolveOrCreateUser(
  db: SupabaseClient,
  email: string,
): Promise<{ userId: string } | null> {
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (created?.user?.id) return { userId: created.user.id };

  const code = (error as { code?: string } | null)?.code;
  const alreadyExists =
    code === 'email_exists' ||
    code === 'user_already_exists' ||
    /already|exists|duplicate/i.test(error?.message ?? '');
  if (!alreadyExists) {
    throw new Error(`auth user creation failed: ${error?.message ?? 'unknown error'}`);
  }

  // Existing buyer: indexed email lookup via find_auth_user_id_by_email
  // (migration 20260716191000). The RPC rejects ambiguous SSO identities
  // instead of silently granting paid access to the wrong account.
  const { data: existingId, error: lookupError } = await db.rpc(
    'find_auth_user_id_by_email',
    { p_email: email },
  );
  if (lookupError) {
    throw new Error(`auth user lookup failed: ${lookupError.message}`);
  }
  return typeof existingId === 'string' && existingId
    ? { userId: existingId }
    : null;
}

/**
 * Post-purchase provisioning hook: fires once, on the first successful main
 * purchase, after the auth user exists. Whatever a new member needs seeded
 * before their first visit belongs behind this call — the boilerplate ships it
 * as a stub route that 200s and does nothing.
 */
async function provisionMemberArea(userId: string, locale: string | null): Promise<void> {
  if (!runtime.customerSideEffectsEnabled || !PWA_URL || !INTERNAL_API_SECRET) return;
  try {
    const response = await fetch(`${PWA_URL}/api/internal/provision-member-area`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_API_SECRET },
      body: JSON.stringify({ userId, locale: locale ?? undefined }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) console.error('[solidgate-webhooks] provision failed:', await response.text());
  } catch (err) {
    console.error('[solidgate-webhooks] provision failed:', err instanceof Error ? err.message : err);
  }
}

async function sendDisputeAlert(text: string): Promise<void> {
  if (!runtime.slackWebhookUrl) return;
  try {
    const response = await fetch(runtime.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) console.error('[solidgate-webhooks] Slack alert failed:', await response.text());
  } catch (err) {
    console.error('[solidgate-webhooks] Slack alert failed:', err instanceof Error ? err.message : err);
  }
}

// ── card_gate.order.updated ─────────────────────────────────────────────────
//
// The multiplexed one: success, decline, settle, void and refund all arrive
// here. It is also how a charge that was still `processing` when our API route
// answered finally gets recognised — the safety net under the OTO chain.

function isoSolidgateDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type NormalizedCardOrderTransaction = CardOrderTransaction & {
  id: string;
  resolvedCardToken: string | null;
  resolvedOriginalPaymentMethod: SolidgateOriginalPaymentMethod | null;
  resolvedCardBrand: string | null;
  resolvedCardNumber: string | null;
};

function optionalWebhookCardString(
  value: unknown,
): { valid: boolean; value: string | null } {
  if (value == null) return { valid: true, value: null };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

function mergeWebhookCardValue(
  left: string | null,
  right: string | null,
): { valid: boolean; value: string | null } {
  if (left !== null && right !== null && left !== right) {
    return { valid: false, value: null };
  }
  return { valid: true, value: left ?? right };
}

function optionalWebhookOriginalPaymentMethod(value: unknown): {
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

/** `token` identifies a later token charge and is not origin provenance. */
function optionalWebhookOrderPaymentMethod(value: unknown): {
  valid: boolean;
  value: SolidgateOriginalPaymentMethod | null;
} {
  if (value === 'token') return { valid: true, value: null };
  return optionalWebhookOriginalPaymentMethod(value);
}

function isWebhookOperationAlignedReusableCredential(
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

function normalizedWebhookCardDetails(
  transaction: CardOrderTransaction,
  orderPaymentMethod: SolidgateOriginalPaymentMethod | null,
): {
  valid: boolean;
  token: string | null;
  originalPaymentMethod: SolidgateOriginalPaymentMethod | null;
  brand: string | null;
  number: string | null;
} {
  const directToken = optionalWebhookCardString(transaction.card_token?.token);
  const nestedToken = optionalWebhookCardString(transaction.card?.card_token?.token);
  const directOriginalPaymentMethod = optionalWebhookOriginalPaymentMethod(
    transaction.card_token?.original_payment_method,
  );
  const nestedOriginalPaymentMethod = optionalWebhookOriginalPaymentMethod(
    transaction.card?.card_token?.original_payment_method,
  );
  const brand = optionalWebhookCardString(transaction.card?.brand);
  const number = optionalWebhookCardString(transaction.card?.number);
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
  const token = mergeWebhookCardValue(directToken.value, nestedToken.value);
  const tokenOriginalPaymentMethod = mergeWebhookCardValue(
    directOriginalPaymentMethod.value,
    nestedOriginalPaymentMethod.value,
  );
  const originalPaymentMethod = tokenOriginalPaymentMethod.valid
    ? mergeWebhookCardValue(tokenOriginalPaymentMethod.value, orderPaymentMethod)
    : { valid: false, value: null };
  const credentialComplete = token.value !== null && originalPaymentMethod.value !== null;
  return {
    valid: token.valid && originalPaymentMethod.valid,
    // Prefer immutable token provenance. Payment Form callbacks can omit it,
    // so signed order.payment_method is the only accepted fallback. Never use
    // browser-selected state, and fail closed when provider fields conflict.
    token: credentialComplete ? token.value : null,
    originalPaymentMethod: originalPaymentMethod.valid
      ? originalPaymentMethod.value as SolidgateOriginalPaymentMethod | null
      : null,
    brand: brand.value,
    number: number.value,
  };
}

function cardOrderTransactions(
  event: CardOrderEvent,
): NormalizedCardOrderTransaction[] | null {
  const orderPaymentMethod = optionalWebhookOrderPaymentMethod(event.order?.payment_method);
  if (!orderPaymentMethod.valid) return null;
  const byId = new Map<string, NormalizedCardOrderTransaction>();
  const add = (transaction: CardOrderTransaction, mapId?: string): boolean => {
    const nestedId = optionalWebhookCardString(transaction.id);
    if (!nestedId.valid) return false;
    const canonicalMapId = mapId === undefined ? null : optionalWebhookCardString(mapId);
    if (canonicalMapId && (!canonicalMapId.valid || !canonicalMapId.value)) return false;
    const id = canonicalMapId?.value ?? nestedId.value;
    if (!id || (canonicalMapId?.value && nestedId.value && canonicalMapId.value !== nestedId.value)) {
      return false;
    }
    const details = normalizedWebhookCardDetails(transaction, orderPaymentMethod.value);
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
    const token = mergeWebhookCardValue(existing.resolvedCardToken, details.token);
    const originalPaymentMethod = mergeWebhookCardValue(
      existing.resolvedOriginalPaymentMethod,
      details.originalPaymentMethod,
    );
    const brand = mergeWebhookCardValue(existing.resolvedCardBrand, details.brand);
    const number = mergeWebhookCardValue(existing.resolvedCardNumber, details.number);
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

  if (event.transaction && !add(event.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(event.transactions ?? {})) {
    if (!transaction || typeof transaction !== 'object' || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function vaultableWebhookCardAuthorization(
  event: CardOrderEvent,
  amountCents: number,
  currency: string,
): NormalizedCardOrderTransaction | null {
  const transactions = cardOrderTransactions(event);
  if (!transactions) return null;
  const candidates = transactions.filter((transaction) => (
    transaction.status === 'success' &&
    isWebhookOperationAlignedReusableCredential(
      transaction.operation,
      transaction.resolvedOriginalPaymentMethod,
    ) &&
    transaction.amount === amountCents &&
    transaction.currency?.toLowerCase() === currency &&
    transaction.resolvedCardToken !== null
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Financial proof is independent from reusable-card provenance. A malformed
 * auth token must only cost the future OTO convenience; it must not erase a
 * valid capture. Conversely, explicit settle duplicates must agree on their
 * canonical transaction identity and money fields before they can be summed.
 */
function financialSettlementTransactions(event: CardOrderEvent): CardOrderTransaction[] | null {
  const byId = new Map<string, CardOrderTransaction>();
  const add = (transaction: CardOrderTransaction, mapId?: string): boolean => {
    if (transaction.operation !== 'settle') return true;
    const nestedId = optionalWebhookCardString(transaction.id);
    if (!nestedId.valid) return false;
    const canonicalMapId = mapId === undefined ? null : optionalWebhookCardString(mapId);
    if (canonicalMapId && (!canonicalMapId.valid || !canonicalMapId.value)) return false;
    const id = canonicalMapId?.value ?? nestedId.value;
    if (!id || (canonicalMapId?.value && nestedId.value && canonicalMapId.value !== nestedId.value)) {
      return false;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...transaction, id });
      return true;
    }
    if (
      existing.amount !== transaction.amount ||
      existing.currency !== transaction.currency ||
      existing.operation !== transaction.operation ||
      existing.status !== transaction.status
    ) return false;
    return true;
  };

  if (event.transaction && !add(event.transaction)) return null;
  for (const [mapId, transaction] of Object.entries(event.transactions ?? {})) {
    if (!transaction || typeof transaction !== 'object' || !add(transaction, mapId)) return null;
  }
  return [...byId.values()];
}

function capturedAmount(event: CardOrderEvent): number | null {
  if (typeof event.order?.settled_amount === 'number') {
    return Number.isSafeInteger(event.order.settled_amount) && event.order.settled_amount >= 0
      ? event.order.settled_amount
      : null;
  }
  const transactions = financialSettlementTransactions(event);
  if (!transactions) return null;
  const settled = transactions.filter(
    (tx) => tx.status === 'success' && tx.operation === 'settle',
  );
  if (settled.length > 0) {
    const currency = event.order?.currency?.toLowerCase();
    let total = 0;
    for (const transaction of settled) {
      if (
        !Number.isSafeInteger(transaction.amount)
        || (transaction.amount ?? -1) < 0
        || !currency
        || transaction.currency?.toLowerCase() !== currency
      ) return null;
      total += transaction.amount as number;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  }
  // The published card webhook schema has no settled_amount field, and
  // order.amount is the original authorization amount. For partial_settled it
  // is therefore not capture evidence; only an explicit extension field or a
  // successful settle transaction can prove the full bound amount moved.
  if (event.order?.status === 'partial_settled') return null;
  const amount = event.order?.amount;
  return Number.isSafeInteger(amount) && (amount ?? -1) >= 0 ? amount! : null;
}

interface InitialOrderBindingRow {
  id: string;
  psp: string;
  payment_environment: string;
  solidgate_order_id: string;
  session_id: string | null;
  user_id: string | null;
  status: string;
  product_name: string;
  product_slug: string;
  currency: string;
  amount_cents: number;
  created_at: string;
  tracking_metadata: unknown;
  solidgate_original_amount_cents: number | null;
  solidgate_refunded_amount_cents: number | null;
  solidgate_subscription_id: string | null;
  solidgate_payment_status: string | null;
  solidgate_chargeback_id: string | null;
  solidgate_chargeback_status: string | null;
  solidgate_chargeback_amount_cents: number | null;
  solidgate_pre_dispute_status: string | null;
  solidgate_customer_email: string | null;
  solidgate_checkout_locale: string | null;
  solidgate_product_id: string | null;
  solidgate_payment_action: string | null;
  solidgate_checkout_identity_legacy: boolean;
}

const INITIAL_ORDER_BINDING_COLUMNS =
  'id,psp,payment_environment,solidgate_order_id,session_id,user_id,status,product_name,product_slug,currency,amount_cents,created_at,tracking_metadata,solidgate_original_amount_cents,solidgate_refunded_amount_cents,solidgate_subscription_id,solidgate_payment_status,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_pre_dispute_status,solidgate_customer_email,solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,solidgate_checkout_identity_legacy';

interface TrustedPositiveSettlement {
  metadata: Record<string, string>;
  session: { user_id?: string | null } | null;
  email: string;
  checkoutLocale: string;
  customerAccountId: string;
  subscriptionId: string | null;
  productId: string | null;
  priceId: string | null;
  amountCents: number;
  currency: string;
}

function metadataEntries(value: unknown, label: string): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`positive settlement ${label} metadata is missing`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, candidate]) => typeof candidate !== 'string')) {
    throw new Error(`positive settlement ${label} metadata is invalid`);
  }
  return (entries as Array<[string, string]>).sort(([a], [b]) => a.localeCompare(b));
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A valid signature proves Solidgate sent the callback, not that every field
 * belongs to this merchant order. Positive money movement is therefore bound
 * to the immutable row/session/tracking snapshot before the first mutation,
 * grant, analytics event, token promotion, or fulfillment enqueue.
 */
async function assertPositiveSettlementBinding(
  db: SupabaseClient,
  event: CardOrderEvent,
  row: InitialOrderBindingRow,
  environment: PaymentEnvironment,
  observedCapturedAmount: number | null,
): Promise<TrustedPositiveSettlement> {
  const order = event.order;
  const trustedEntries = metadataEntries(row.tracking_metadata, 'trusted');
  const callbackEntries = metadataEntries(event.order_metadata, 'callback');
  if (JSON.stringify(callbackEntries) !== JSON.stringify(trustedEntries)) {
    throw new Error('positive settlement metadata binding mismatch');
  }
  const metadata = Object.fromEntries(trustedEntries);
  const expectedAccountRef = row.session_id ?? (row.user_id ? `u-${row.user_id}` : null);
  const expectedAmount = row.solidgate_original_amount_cents ?? row.amount_cents;
  const orderParts = row.solidgate_order_id?.split(':') ?? [];

  if (
    row.psp !== 'solidgate'
    || row.payment_environment !== environment
    || !row.solidgate_order_id
    || order?.order_id !== row.solidgate_order_id
    || !expectedAccountRef
    || metadata.session_id !== expectedAccountRef
    || !metadata.product_slug
    || !metadata.funnel_code
    || !metadata.funnel_variant
    || productTokenFromSlug(metadata.product_slug) !== productToken(row.product_slug)
    || row.product_name !== row.product_slug
    || orderParts.length !== 3
    || orderParts[0] !== expectedAccountRef
    || orderParts[1] !== metadata.product_slug
    || !/^[1-9][0-9]{0,8}$/.test(orderParts[2] ?? '')
  ) {
    throw new Error('positive settlement canonical order binding mismatch');
  }

  if (
    !Number.isSafeInteger(expectedAmount)
    || expectedAmount < 0
    || order?.amount !== expectedAmount
    || observedCapturedAmount !== expectedAmount
  ) {
    throw new Error('positive settlement amount binding mismatch');
  }
  if (
    typeof order.currency !== 'string'
    || order.currency.toLowerCase() !== row.currency.toLowerCase()
  ) {
    throw new Error('positive settlement currency binding mismatch');
  }

  const expectsSubscription = isMainSubscription(row.product_slug) || isRecurringAddon(row.product_slug);
  const priceId = metadata.price_id ?? null;
  const productId = row.solidgate_product_id;
  const callbackSubscriptionId = typeof order.subscription_id === 'string' && order.subscription_id
    ? order.subscription_id
    : null;
  if (expectsSubscription) {
    if (
      !priceId
      || !UUID_PATTERN.test(priceId)
      || !productId
      || order.product_id !== productId
      || !callbackSubscriptionId
      || (
        row.solidgate_subscription_id !== null
        && row.solidgate_subscription_id !== callbackSubscriptionId
      )
    ) {
      throw new Error('positive settlement product, price, or subscription binding mismatch');
    }
  } else if (
    productId !== null
    || row.solidgate_payment_action !== 'auth_settle'
    || priceId !== null
    || order.product_id != null
    || callbackSubscriptionId !== null
  ) {
    throw new Error('positive settlement one-time product binding mismatch');
  }

  let session: TrustedPositiveSettlement['session'] = null;
  if (
    row.solidgate_checkout_identity_legacy
    || typeof row.solidgate_customer_email !== 'string'
    || normalizedEmail(row.solidgate_customer_email) !== row.solidgate_customer_email
    || typeof row.solidgate_checkout_locale !== 'string'
    || !row.solidgate_checkout_locale
    || row.solidgate_payment_action !== (
      isMainSubscription(row.product_slug) && expectedAmount === 0
        ? 'auth_0_amount'
        : 'auth_settle'
    )
  ) {
    throw new Error('positive settlement immutable checkout identity is missing');
  }

  const trustedEmail = row.solidgate_customer_email;
  if (row.session_id) {
    const { data, error } = await db
      .from('sessions')
      .select('user_id')
      .eq('id', row.session_id)
      .maybeSingle();
    if (error) throw new Error(`positive settlement session binding read failed: ${error.message}`);
    if (!data) throw new Error('positive settlement session binding mismatch');
    session = data;
    if (data.user_id != null && data.user_id !== row.user_id) {
      // A still-unclaimed order whose session already belongs to the buyer is
      // not tampering: grant polling stops at auth_ok, so the buyer can reach
      // the PWA login and claim the session before this settle callback lands.
      // Accept only the exact account the order's immutable email resolves to;
      // any other session owner keeps the hard mismatch.
      if (row.user_id != null) {
        throw new Error('positive settlement customer ownership binding mismatch');
      }
      const { data: buyerUserId, error: buyerLookupError } = await db.rpc(
        'find_auth_user_id_by_email',
        { p_email: trustedEmail },
      );
      if (buyerLookupError) {
        throw new Error(
          `positive settlement buyer account lookup failed: ${buyerLookupError.message}`,
        );
      }
      if (buyerUserId !== data.user_id) {
        throw new Error('positive settlement customer ownership binding mismatch');
      }
    }
  }

  const customerAccountId = row.session_id ?? row.user_id;
  if (
    !customerAccountId
    || order.customer_account_id !== customerAccountId
    || typeof order.customer_email !== 'string'
    || normalizedEmail(order.customer_email) !== normalizedEmail(trustedEmail)
  ) {
    throw new Error('positive settlement customer binding mismatch');
  }

  return {
    metadata,
    session,
    email: trustedEmail,
    checkoutLocale: row.solidgate_checkout_locale,
    customerAccountId,
    subscriptionId: callbackSubscriptionId,
    productId,
    priceId,
    amountCents: expectedAmount,
    currency: row.currency.toLowerCase(),
  };
}

type DurableSpecialFreeEntitlement = {
  order_id?: string | null;
  user_id?: string | null;
  product_slug?: string | null;
  access_level?: string | null;
  solidgate_subscription_id?: string | null;
  status?: string | null;
  revoked_at?: string | null;
};

type DurableSpecialFreeGrantDisposition =
  | 'complete'
  | 'recoverable'
  | 'unready';

/**
 * A later Solidgate delivery may omit the authorization transaction after an
 * earlier token-bearing delivery already finalized the order. ACK that replay
 * only when the entire durable grant is present. If card readiness is proven
 * but the exact grant is absent, classify it for downstream recovery: the
 * earlier invocation may have failed after changing the order but before
 * creating/linking the account and entitlement. A non-exact entitlement can
 * be an older purchase that this order legitimately replaces, so only the
 * atomic grant RPC may arbitrate it against the source order.
 */
async function durableSpecialFreeGrantDisposition(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    row: InitialOrderBindingRow;
    subscriptionId: string;
  },
): Promise<DurableSpecialFreeGrantDisposition> {
  const { data: cardReady, error: cardReadyError } = await db.rpc(
    'solidgate_special_free_card_ready',
    { p_order_id: params.row.id },
  );
  if (cardReadyError) {
    throw new Error(
      `special_free durable card readiness check failed: ${cardReadyError.message}`,
    );
  }
  if (cardReady !== true) return 'unready';

  let entitlementQuery = db
    .from('entitlements')
    .select('order_id,user_id,product_slug,access_level,solidgate_subscription_id,status,revoked_at')
    .eq('payment_environment', params.environment);
  entitlementQuery = params.row.user_id
    ? entitlementQuery
        .eq('user_id', params.row.user_id)
        .eq('product_slug', params.row.product_slug)
    : entitlementQuery.eq('order_id', params.row.id);
  const { data, error } = await entitlementQuery.maybeSingle();
  if (error) {
    throw new Error(`special_free durable entitlement read failed: ${error.message}`);
  }
  const entitlement = data as DurableSpecialFreeEntitlement | null;
  if (!entitlement) return 'recoverable';
  if (
    params.row.user_id
    && params.row.solidgate_subscription_id === params.subscriptionId
    && entitlement.order_id === params.row.id
    && entitlement.user_id === params.row.user_id
    && entitlement.product_slug === params.row.product_slug
    && entitlement.access_level === 'full'
    && entitlement.solidgate_subscription_id === params.subscriptionId
    && entitlement.status === 'active'
    && entitlement.revoked_at == null
  ) return 'complete';
  return 'recoverable';
}

/**
 * A successful order transition and its grants/outbox writes cannot share one
 * Supabase transaction. If a later write fails, the same webhook retries with
 * an already-settled order and loses the pending/failed CAS. Re-read the row
 * and continue only when it is still the exact, unreversed capture this event
 * proved. A terminal or different successful winner owns the state and stops
 * this worker; a mysteriously still-open row remains retryable.
 */
async function recoverCapturedOrderAfterLostSettlementClaim(
  db: SupabaseClient,
  params: {
    environment: PaymentEnvironment;
    orderId: string;
    original: InitialOrderBindingRow;
    binding: TrustedPositiveSettlement;
    providerStatus: string;
  },
): Promise<InitialOrderBindingRow | null> {
  const { data, error } = await db
    .from('orders')
    .select(INITIAL_ORDER_BINDING_COLUMNS)
    .eq('payment_environment', params.environment)
    .eq('solidgate_order_id', params.orderId)
    .maybeSingle();
  if (error) throw new Error(`settled order recovery read failed: ${error.message}`);
  if (!data) throw new Error('settled order disappeared after settlement claim');

  const durable = data as InitialOrderBindingRow;
  if (
    terminalOrderPreventsGrant(durable)
    || (durable.solidgate_refunded_amount_cents ?? 0) > 0
    || await originalEntitlementWasRevoked(db, durable.id, params.environment)
  ) {
    return null;
  }

  const successfulDurableStatus = params.binding.subscriptionId
    ? durable.status === 'trialing' || durable.status === 'active'
    : durable.status === 'completed';
  const sameImmutableOrder =
    durable.id === params.original.id
    && durable.psp === 'solidgate'
    && durable.payment_environment === params.environment
    && durable.solidgate_order_id === params.orderId
    && durable.session_id === params.original.session_id
    && durable.product_name === params.original.product_name
    && durable.product_slug === params.original.product_slug
    && durable.created_at === params.original.created_at
    && durable.solidgate_customer_email === params.original.solidgate_customer_email
    && durable.solidgate_checkout_locale === params.original.solidgate_checkout_locale
    && durable.solidgate_product_id === params.original.solidgate_product_id
    && durable.solidgate_payment_action === params.original.solidgate_payment_action
    && durable.solidgate_checkout_identity_legacy === false
    && JSON.stringify(metadataEntries(durable.tracking_metadata, 'recovered')) ===
      JSON.stringify(metadataEntries(params.original.tracking_metadata, 'original'));
  const sameCapturedPayment =
    durable.amount_cents === params.binding.amountCents
    && durable.solidgate_original_amount_cents === params.binding.amountCents
    && durable.currency.toLowerCase() === params.original.currency.toLowerCase()
    && durable.solidgate_subscription_id === params.binding.subscriptionId
    && durable.solidgate_payment_status === params.providerStatus;

  if (successfulDurableStatus && sameImmutableOrder && sameCapturedPayment) return durable;
  if (durable.status === 'pending' || durable.status === 'failed') {
    throw new Error('settlement claim was lost but no durable winner is visible');
  }
  return null;
}

interface RenewalOrderMapping {
  solidgate_invoice_id: string;
  solidgate_subscription_id: string;
  amount_cents: number;
  currency: string;
  refunded_amount_cents: number;
  product_price_id: string | null;
  order_metadata: Record<string, string> | null;
}

async function renewalAnalyticsContext(
  db: SupabaseClient,
  event: CardOrderEvent,
  mapping: RenewalOrderMapping,
  environment: PaymentEnvironment,
): Promise<Record<string, unknown>> {
  const { data: origin, error: originError } = await db
    .from('orders')
    .select('session_id,user_id,product_slug,currency,solidgate_checkout_locale')
    .eq('payment_environment', environment)
    .eq('solidgate_subscription_id', mapping.solidgate_subscription_id)
    .maybeSingle();
  if (originError) throw new Error(`renewal origin lookup failed: ${originError.message}`);
  const metadata = { ...(mapping.order_metadata ?? {}) };
  const canonicalProductSlug = metadata.product_slug ?? metadata.tier ??
    slugFromCode(origin?.product_slug ?? null) ?? origin?.product_slug ?? null;
  const productCode = metadata.product_code ?? origin?.product_slug ?? null;
  const priceId = mapping.product_price_id ?? metadata.price_id ?? null;
  return {
    provider: 'solidgate',
    payment_provider: 'solidgate',
    session_id: origin?.session_id ?? metadata.session_id ?? null,
    user_id: origin?.user_id ?? null,
    product_slug: canonicalProductSlug,
    product: canonicalProductSlug,
    product_name: canonicalProductName(
      typeof canonicalProductSlug === 'string' ? canonicalProductSlug : productCode,
      event.order?.product_name ?? metadata.product_name,
    ),
    product_code: productCode,
    product_id: metadata.product_id ?? productCode,
    solidgate_product_id: event.order?.product_id ?? null,
    solidgate_product_name: event.order?.product_name ?? null,
    price_id: priceId,
    solidgate_price_id: priceId,
    locale: origin?.solidgate_checkout_locale ?? metadata.locale ?? null,
    surface: origin?.session_id ? 'funnel' : 'pwa',
    app: origin?.session_id ? 'funnel' : 'pwa',
    funnel_code: metadata.funnel_code,
    funnel_variant: trackingFunnelVariant(metadata),
    tier: metadata.tier ?? metadata.product_slug,
    utm_source: metadata.utm_source,
    utm_medium: metadata.utm_medium,
    utm_campaign: metadata.utm_campaign,
    utm_content: metadata.utm_content,
    utm_term: metadata.utm_term,
  };
}

async function handleRecurringOrderUpdated(
  db: SupabaseClient,
  event: CardOrderEvent,
  context?: WebhookContext,
): Promise<boolean> {
  const orderId = event.order?.order_id;
  if (!orderId) return false;
  const environment = paymentEnvironment(context);
  const { data: mapping, error: mappingError } = await db
    .from('solidgate_invoice_orders')
    .select('solidgate_invoice_id,solidgate_subscription_id,amount_cents,currency,refunded_amount_cents,status,product_price_id,order_metadata')
    .eq('environment', environment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  if (mappingError) throw new Error(`recurring order lookup failed: ${mappingError.message}`);
  if (!mapping) return false;
  const analyticsContext = await renewalAnalyticsContext(
    db,
    event,
    mapping as RenewalOrderMapping,
    environment,
  );

  const status = event.order?.status ?? '';
  const eventCreatedAt = context?.eventCreatedAt ?? null;
  const common = {
    status,
    event_created_at: eventCreatedAt,
    updated_at: new Date().toISOString(),
  };

  if (status === 'refunded') {
    const refunded = Math.max(0, event.order?.refunded_amount ?? 0);
    const refundDelta = Math.max(0, refunded - (mapping.refunded_amount_cents ?? 0));
    const { error: mappingUpdateError } = await db.from('solidgate_invoice_orders').update({
      ...common,
      refunded_amount_cents: refunded,
    }).eq('environment', environment).eq('solidgate_order_id', orderId);
    if (mappingUpdateError) {
      throw new Error(`recurring refund mapping update failed: ${mappingUpdateError.message}`);
    }

    const { data: renewal, error: renewalError } = await db
      .from('renewal_events')
      .select('gross_amount_cents,amount_cents')
      .eq('payment_environment', environment)
      .eq('solidgate_invoice_id', mapping.solidgate_invoice_id)
      .maybeSingle();
    if (renewalError) throw new Error(`renewal refund lookup failed: ${renewalError.message}`);
    if (renewal) {
      const gross = renewal.gross_amount_cents ?? mapping.amount_cents ?? renewal.amount_cents ?? 0;
      const net = Math.max(0, gross - refunded);
      const { error: renewalUpdateError } = await db.from('renewal_events').update({
        amount_cents: net,
        refunded_amount_cents: refunded,
        status: net === 0 ? 'refunded' : 'partially_refunded',
        event_created_at: eventCreatedAt,
      }).eq('payment_environment', environment)
        .eq('solidgate_invoice_id', mapping.solidgate_invoice_id);
      if (renewalUpdateError) {
        throw new Error(`renewal refund update failed: ${renewalUpdateError.message}`);
      }
    }
    await enqueueAnalytics(db, {
      eventKey: `renewal:${mapping.solidgate_invoice_id}:refunded:${refunded}`,
      eventName: 'payment_refunded',
      distinctId: mapping.solidgate_subscription_id,
      properties: {
        ...analyticsContext,
        environment: context?.environment ?? runtime.environment,
        billing_type: 'subscription_renewal',
        solidgate_order_id: orderId,
        solidgate_invoice_id: mapping.solidgate_invoice_id,
        solidgate_subscription_id: mapping.solidgate_subscription_id,
        refunded_amount_cents: refunded,
        refund_amount_cents: refundDelta,
        revenue: -refundDelta,
        currency: (event.order?.currency ?? mapping.currency ?? '').toUpperCase(),
      },
    });
    return true;
  }

  if (status === 'void_ok') {
    const { error: mappingUpdateError } = await db.from('solidgate_invoice_orders').update(common)
      .eq('environment', environment).eq('solidgate_order_id', orderId);
    if (mappingUpdateError) {
      throw new Error(`recurring void mapping update failed: ${mappingUpdateError.message}`);
    }
    const { error: renewalUpdateError } = await db.from('renewal_events').update({
      amount_cents: 0,
      status: 'voided',
      event_created_at: eventCreatedAt,
    }).eq('payment_environment', environment)
      .eq('solidgate_invoice_id', mapping.solidgate_invoice_id);
    if (renewalUpdateError) {
      throw new Error(`renewal void update failed: ${renewalUpdateError.message}`);
    }
    await enqueueAnalytics(db, {
      eventKey: `renewal:${mapping.solidgate_invoice_id}:voided`,
      eventName: 'payment_voided',
      distinctId: mapping.solidgate_subscription_id,
      properties: {
        ...analyticsContext,
        environment: context?.environment ?? runtime.environment,
        billing_type: 'subscription_renewal',
        solidgate_order_id: orderId,
        solidgate_invoice_id: mapping.solidgate_invoice_id,
        solidgate_subscription_id: mapping.solidgate_subscription_id,
      },
    });
    return true;
  }

  if (FAILED_ORDER_STATUSES.has(status)) {
    const { error: mappingUpdateError } = await db.from('solidgate_invoice_orders').update(common)
      .eq('environment', environment).eq('solidgate_order_id', orderId);
    if (mappingUpdateError) {
      throw new Error(`recurring decline mapping update failed: ${mappingUpdateError.message}`);
    }
    await enqueueAnalytics(db, {
      eventKey: `subscription:${mapping.solidgate_subscription_id}:payment-failed:${mapping.solidgate_invoice_id}`,
      eventName: 'subscription_payment_failed',
      distinctId: mapping.solidgate_subscription_id,
      properties: {
        ...analyticsContext,
        environment: context?.environment ?? runtime.environment,
        billing_type: 'subscription_renewal',
        solidgate_order_id: orderId,
        solidgate_invoice_id: mapping.solidgate_invoice_id,
        solidgate_subscription_id: mapping.solidgate_subscription_id,
        decline_code: event.error?.code,
      },
    });
    return true;
  }

  const { error: mappingUpdateError } = await db.from('solidgate_invoice_orders').update(common)
    .eq('environment', environment).eq('solidgate_order_id', orderId);
  if (mappingUpdateError) {
    throw new Error(`recurring order status update failed: ${mappingUpdateError.message}`);
  }
  return true;
}

async function handleOrderUpdated(
  db: SupabaseClient,
  event: CardOrderEvent,
  context?: WebhookContext,
): Promise<void> {
  const order = event.order;
  const orderId = order?.order_id;
  if (!orderId) return;
  const environment = paymentEnvironment(context);

  // Our order or someone else's? The row IS the brand guard: we only ever act on
  // orders this system opened.
  const { data: row, error: orderLookupError } = await db
    .from('orders')
    .select(INITIAL_ORDER_BINDING_COLUMNS)
    .eq('payment_environment', environment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  if (orderLookupError) throw new Error(`order lookup failed: ${orderLookupError.message}`);
  if (!row) {
    if (await handleRecurringOrderUpdated(db, event, context)) return;
    if (order?.subscription_id) {
      const { data: parent, error: parentError } = await db.from('orders')
        .select('product_slug')
        .eq('payment_environment', environment)
        .eq('solidgate_subscription_id', order.subscription_id)
        .maybeSingle();
      if (parentError) throw new Error(`recurring parent lookup failed: ${parentError.message}`);
      if (parent && isOurProduct(parent.product_slug)) {
        // The subscription webhook populates the invoice/order mapping. Ask
        // Solidgate to retry instead of losing a generated renewal order that
        // happened to arrive first.
        throw new Error(`recurring order ${orderId} mapping not ready`);
      }
    }
    console.log('[solidgate-webhooks] order not ours, ignoring', { orderId });
    return;
  }
  if (!isOurProduct(row.product_slug)) return;
  // Callback metadata is untrusted input. Positive events compare it exactly
  // below; every branch consumes only the immutable merchant snapshot.
  const orderMetadata = stringMetadata(row.tracking_metadata);

  const status = order?.status ?? '';
  const trustedSubscriptionId = row.solidgate_subscription_id ?? null;

  // ── Refund ───────────────────────────────────────────────────────────────
  if (status === 'refunded') {
    // Solidgate sends the cumulative refunded amount. Preserve gross and make
    // amount_cents net so existing admin revenue queries stay correct.
    const gross = row.solidgate_original_amount_cents ??
      ((row.amount_cents ?? 0) + (row.solidgate_refunded_amount_cents ?? 0));
    const refunded = Math.min(gross, Math.max(0, order?.refunded_amount ?? 0));
    const net = Math.max(0, gross - refunded);
    const refundDelta = Math.max(0, refunded - (row.solidgate_refunded_amount_cents ?? 0));
    const full = net === 0;

    const { data: refundedOrder, error: refundUpdateError } = await db.from('orders').update({
      // A partial refund does not own the lifecycle status. Omitting the field
      // preserves a successful browser/webhook winner that committed after
      // our initial read. A full refund is authoritative and must terminate it.
      ...(full && { status: 'refunded' }),
      amount_cents: net,
      solidgate_original_amount_cents: gross,
      solidgate_refunded_amount_cents: refunded,
      solidgate_payment_status: status,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    })
      .eq('payment_environment', environment)
      .eq('id', row.id)
      .eq('solidgate_order_id', orderId)
      .select(INITIAL_ORDER_BINDING_COLUMNS)
      .maybeSingle();
    if (refundUpdateError) throw new Error(`order refund update failed: ${refundUpdateError.message}`);
    if (!refundedOrder) throw new Error('order refund update lost its exact order');
    const effectiveRow = refundedOrder as InitialOrderBindingRow;
    if (full) {
      await revokeInitialOrderEntitlement(db, {
        environment,
        orderId: effectiveRow.id,
        reason: 'refund',
      });
    }
    await enqueueOrderAnalytics(db, {
      orderId,
      productSlug: effectiveRow.product_slug,
      subscriptionId: effectiveRow.solidgate_subscription_id,
      amountCents: net,
      currency: (effectiveRow.currency ?? '').toLowerCase(),
      sessionId: effectiveRow.session_id,
      userId: effectiveRow.user_id,
      email: null,
      locale: null,
      eventKeySuffix: `refunded:${refunded}`,
      eventName: 'payment_refunded',
      paymentStatus: status,
      metadata: orderMetadata,
      solidgateProductId: null,
      solidgateProductName: null,
      priceId: orderMetadata.price_id ?? null,
      refundAmountCents: refundDelta,
      refundedAmountCents: refunded,
    });
    return;
  }

  // ── Void ─────────────────────────────────────────────────────────────────
  if (status === 'void_ok') {
    const { data: voidedOrder, error: voidUpdateError } = await db.from('orders').update({
      status: 'failed',
      amount_cents: 0,
      solidgate_original_amount_cents: row.solidgate_original_amount_cents ?? row.amount_cents,
      solidgate_payment_status: status,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    })
      .eq('payment_environment', environment)
      .eq('id', row.id)
      .eq('solidgate_order_id', orderId)
      .select(INITIAL_ORDER_BINDING_COLUMNS)
      .maybeSingle();
    if (voidUpdateError) throw new Error(`order void update failed: ${voidUpdateError.message}`);
    if (!voidedOrder) throw new Error('order void update lost its exact order');
    const effectiveRow = voidedOrder as InitialOrderBindingRow;
    await revokeInitialOrderEntitlement(db, {
      environment,
      orderId: effectiveRow.id,
      reason: 'void',
    });
    await enqueueOrderAnalytics(db, {
      orderId,
      productSlug: effectiveRow.product_slug,
      subscriptionId: effectiveRow.solidgate_subscription_id,
      amountCents: 0,
      currency: (effectiveRow.currency ?? '').toLowerCase(),
      sessionId: effectiveRow.session_id,
      userId: effectiveRow.user_id,
      email: null,
      locale: null,
      eventKeySuffix: 'voided',
      eventName: 'payment_voided',
      paymentStatus: status,
      metadata: orderMetadata,
      solidgateProductId: null,
      solidgateProductName: null,
      priceId: orderMetadata.price_id ?? null,
    });
    return;
  }

  // Never let a late settle/active callback resurrect access after our durable
  // refund, cancellation, dispute, void, or explicit entitlement revocation.
  // The DB trigger is the atomic last line of defence; this guard lets us ACK
  // harmless replays instead of retrying a trigger rejection forever.
  if (
    terminalOrderPreventsGrant(row as DurableGrantOrderState) ||
    await originalEntitlementWasRevoked(db, row.id, environment)
  ) {
    return;
  }

  // ── Decline ──────────────────────────────────────────────────────────────
  if (FAILED_ORDER_STATUSES.has(status)) {
    // Never downgrade an order that already succeeded (events are unordered).
    if (
      row.status === 'completed'
      || row.status === 'active'
      || row.status === 'trialing'
      || row.status === 'past_due'
    ) return;
    const { data: declinedOrder, error: declineUpdateError } = await db.from('orders').update({
      status: 'failed',
      amount_cents: 0,
      solidgate_original_amount_cents: row.solidgate_original_amount_cents ?? row.amount_cents,
      solidgate_payment_status: status,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    })
      .eq('payment_environment', environment)
      .eq('id', row.id)
      .eq('solidgate_order_id', orderId)
      .in('status', ['pending', 'failed'])
      .select('id')
      .maybeSingle();
    if (declineUpdateError) throw new Error(`order decline update failed: ${declineUpdateError.message}`);
    if (!declinedOrder) {
      // A browser poll or positive webhook can finalize this exact order after
      // our read. The pending/failed CAS makes that success authoritative.
      const { data: winner, error: winnerError } = await db.from('orders')
        .select(INITIAL_ORDER_BINDING_COLUMNS)
        .eq('payment_environment', environment)
        .eq('id', row.id)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (winnerError) throw new Error(`order decline winner read failed: ${winnerError.message}`);
      if (!winner) throw new Error('order decline CAS lost and the exact order disappeared');
      const durableWinner = winner as InitialOrderBindingRow;
      if (
        durableWinner.status === 'completed'
        || durableWinner.status === 'active'
        || durableWinner.status === 'trialing'
        || durableWinner.status === 'past_due'
        || terminalOrderPreventsGrant(durableWinner)
        || (
          durableWinner.status === 'failed'
          && FAILED_ORDER_STATUSES.has(durableWinner.solidgate_payment_status ?? '')
        )
      ) return;
      throw new Error('order decline CAS lost without a durable winner');
    }
    await enqueueOrderAnalytics(db, {
      orderId,
      productSlug: row.product_slug,
      subscriptionId: trustedSubscriptionId,
      amountCents: 0,
      currency: (row.currency ?? '').toLowerCase(),
      sessionId: row.session_id,
      userId: row.user_id,
      email: null,
      locale: null,
      eventKeySuffix: 'failed',
      eventName: 'payment_failed',
      paymentStatus: status,
      metadata: orderMetadata,
      solidgateProductId: null,
      solidgateProductName: null,
      priceId: orderMetadata.price_id ?? null,
    });
    return;
  }

  // A positive auth_ok is only a reservation. The sole auth-only success we
  // accept is a zero-amount authorization that opened a real subscription.
  const callbackSubscriptionId = typeof order?.subscription_id === 'string' && order.subscription_id
    ? order.subscription_id
    : null;
  const zeroAmountTrialAuth = status === 'auth_ok'
    && (row.solidgate_original_amount_cents ?? row.amount_cents) === 0
    && order?.amount === 0
    && !!callbackSubscriptionId;
  const expectedAmount = row.solidgate_original_amount_cents ?? row.amount_cents ?? null;
  const observedCapturedAmount = capturedAmount(event);
  const durableOrderAlreadyCaptured =
    row.status === 'completed'
    || row.status === 'trialing'
    || row.status === 'active'
    || row.status === 'past_due'
    || SETTLED_ORDER_STATUSES.has(row.solidgate_payment_status ?? '');
  if (
    status === 'partial_settled' &&
    (
      expectedAmount === null ||
      observedCapturedAmount === null ||
      observedCapturedAmount < expectedAmount
    )
  ) {
    if (durableOrderAlreadyCaptured) return;
    // `partial_settled` is only a successful checkout when the captured total
    // covers the amount we opened. Never grant access or record revenue for an
    // under-capture; a later full-settlement event can still reconcile it.
    const { error: partialUpdateError } = await db.from('orders').update({
      solidgate_payment_status: status,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    })
      .eq('payment_environment', environment)
      .eq('solidgate_order_id', orderId);
    if (partialUpdateError) {
      throw new Error(`partial settlement update failed: ${partialUpdateError.message}`);
    }
    return;
  }
  if (!zeroAmountTrialAuth && !SETTLED_ORDER_STATUSES.has(status)) {
    if (status === 'auth_ok') {
      if (durableOrderAlreadyCaptured) return;
      const { error: authUpdateError } = await db.from('orders').update({
        solidgate_payment_status: status,
        solidgate_submission_token: null,
        solidgate_submission_started_at: null,
      })
        .eq('payment_environment', environment)
        .eq('solidgate_order_id', orderId)
        .in('status', ['pending', 'failed']);
      if (authUpdateError) throw new Error(`order authorization update failed: ${authUpdateError.message}`);
    }
    return;
  }

  const binding = await assertPositiveSettlementBinding(
    db,
    event,
    row as InitialOrderBindingRow,
    environment,
    observedCapturedAmount,
  );
  // Only the original zero-amount special_free trades access for a reusable
  // card instead of money. Since 2026-07-29 the tier settles a €1 intro
  // (bound gross > 0) and must follow the ordinary paid path, exactly like
  // special_1eur; the card-first gate below would otherwise reject every
  // legitimate €1 settlement.
  const specialFreeOffer = isMainSubscription(row.product_slug)
    && binding.metadata.product_slug === 'special_free'
    && binding.amountCents === 0;
  const tx = vaultableWebhookCardAuthorization(
    event,
    binding.amountCents,
    binding.currency,
  );
  let recoveringTokenlessSpecialFree = false;

  // The free offer is not access in exchange for an authorization status; it
  // is access in exchange for a real reusable payment method attached to the
  // subscription. A signed auth_ok without its exact reusable token cannot
  // prove that we will be able to submit the first charge in seven days.
  // A tokenless callback for an already-recognised order is harmless only if
  // both reusable-card proof and the exact active entitlement are durable.
  // The first invocation may have finalized the order and then failed before
  // vault/account/grant work, so order status alone must never ACK the replay.
  if (
    specialFreeOffer
    && (
      status !== 'auth_ok'
      || binding.amountCents !== 0
      || !binding.subscriptionId
      || !row.session_id
      || !tx?.resolvedCardToken?.trim()
    )
  ) {
    if (durableOrderAlreadyCaptured) {
      const disposition = binding.subscriptionId
        ? await durableSpecialFreeGrantDisposition(db, {
            environment,
            row: row as InitialOrderBindingRow,
            subscriptionId: binding.subscriptionId,
          })
        : 'unready';
      if (disposition === 'complete') return;
      if (
        disposition === 'recoverable'
        && status === 'auth_ok'
        && binding.amountCents === 0
        && binding.subscriptionId
        && row.session_id
      ) {
        recoveringTokenlessSpecialFree = true;
        // Fall through to the existing lost-settlement recovery. The DB has
        // already proved an exact/newer reusable token; this path now repairs
        // the missing account/entitlement without needing Solidgate to repeat
        // transaction details it may omit on later deliveries.
      } else {
        throw new Error('special_free durable reusable card is not ready');
      }
    } else {
      throw new Error('special_free reusable card authorization is missing');
    }
  }
  let effectiveRow = row as InitialOrderBindingRow;
  const subscriptionId = binding.subscriptionId;
  const paidAmount = binding.amountCents;
  const pwaDirectSubscription = !!subscriptionId &&
    orderMetadata.funnel_code === 'PWA' && isRecurringAddon(row.product_slug);
  const contextCreatedAtMs = context?.eventCreatedAt
    ? new Date(context.eventCreatedAt).getTime()
    : Number.NaN;
  const initialPeriodAnchor = Number.isFinite(contextCreatedAtMs) ? contextCreatedAtMs : Date.now();
  const initialSubscriptionExpiresAt = subscriptionId
    ? new Date(initialPeriodAnchor + 7 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // Reconciliation: this is the charge our route left `pending` because
  // Solidgate was still settling. Recognise it now.
  const { data: settledRow, error: settlementUpdateError } = await db
    .from('orders')
    .update({
      status: subscriptionId ? (pwaDirectSubscription ? 'active' : 'trialing') : 'completed',
      ...(subscriptionId && { solidgate_subscription_id: subscriptionId }),
      amount_cents: paidAmount,
      solidgate_original_amount_cents: binding.amountCents,
      solidgate_payment_status: status,
      currency: row.currency.toLowerCase(),
      solidgate_verify_url: null,
      solidgate_submission_token: null,
      solidgate_submission_started_at: null,
    })
    .eq('payment_environment', environment)
    .eq('solidgate_order_id', orderId)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();
  if (settlementUpdateError) {
    throw new Error(`order settlement update failed: ${settlementUpdateError.message}`);
  }
  // A prior attempt may have committed this transition and then failed during
  // account/grant/outbox work. Recover that exact capture so the retry can
  // finish its idempotent effects. A reversal or a different winner stops it.
  if (!settledRow) {
    const recovered = await recoverCapturedOrderAfterLostSettlementClaim(db, {
      environment,
      orderId,
      original: effectiveRow,
      binding,
      providerStatus: status,
    });
    if (!recovered) return;
    effectiveRow = recovered;
  }

  // Resolve reusable-card evidence when present. Paid captures may still
  // publish a tokenless source watermark; special_free was rejected above
  // unless this exact bound authorization carried a reusable token.
  const isPwaOrder = orderMetadata.funnel_code === 'PWA'
    && effectiveRow.session_id === null
    && Boolean(effectiveRow.user_id);
  let pwaCaptureMode: 'hosted_form' | 'saved_card' | 'stale' | null = null;
  let deferredVaultError: Error | null = null;
  if (isPwaOrder && effectiveRow.user_id) {
    const { data: recordedMode, error: recordedModeError } = await db.rpc(
      'record_solidgate_pwa_confirmed_capture',
      {
        p_payment_environment: environment,
        p_user_id: effectiveRow.user_id,
        p_offer_slug: orderMetadata.product_slug,
        p_product_slug: effectiveRow.product_slug,
        p_order_db_id: effectiveRow.id,
        p_solidgate_order_id: orderId,
        p_amount_cents: binding.amountCents,
        p_currency: binding.currency,
        p_provider_status: status,
        p_subscription_id: subscriptionId,
      },
    );
    if (
      recordedModeError ||
      !['hosted_form', 'saved_card', 'stale'].includes(String(recordedMode))
    ) {
      throw new Error(
        `PWA captured state publication failed: ${
          recordedModeError?.message ?? String(recordedMode)
        }`,
      );
    }
    pwaCaptureMode = recordedMode;
  }

  if (
    pwaCaptureMode === 'hosted_form' && effectiveRow.user_id
  ) {
    const digits = (tx?.resolvedCardNumber ?? '').replace(/\D/g, '');
    const { data: accountVaultResult, error: accountVaultError } = await db.rpc(
      'write_solidgate_account_vault_with_method',
      {
        p_payment_environment: environment,
        p_user_id: effectiveRow.user_id,
        p_source_kind: 'pwa_order',
        p_source_id: effectiveRow.id,
        p_source_claim_token: null,
        p_card_token: tx?.resolvedCardToken ?? null,
        p_original_payment_method: tx?.resolvedOriginalPaymentMethod ?? null,
        p_card_brand: tx?.resolvedCardBrand ?? null,
        p_card_last4: digits.length >= 4 ? digits.slice(-4) : null,
      },
    );
    if (
      accountVaultError ||
      !['written', 'same', 'stale'].includes(String(accountVaultResult))
    ) {
      deferredVaultError = new Error(
        `PWA account vault source write failed: ${
          accountVaultError?.message ?? String(accountVaultResult)
        }`,
      );
    }
  }

  if (
    effectiveRow.session_id
    && isMainSubscription(effectiveRow.product_slug)
  ) {
    const masked = tx?.resolvedCardNumber ?? '';
    const digits = masked.replace(/\D/g, '');
    const { data: sessionVaultResult, error: sessionVaultError } = await db.rpc(
      'write_solidgate_session_vault_with_method',
      {
        p_payment_environment: environment,
        p_session_id: effectiveRow.session_id,
        p_source_order_id: effectiveRow.id,
        p_customer_account_id: binding.customerAccountId,
        p_card_token: tx?.resolvedCardToken ?? null,
        p_original_payment_method: tx?.resolvedOriginalPaymentMethod ?? null,
        p_card_brand: tx?.resolvedCardBrand ?? null,
        p_card_last4: digits.length >= 4 ? digits.slice(-4) : null,
      },
    );
    if (
      sessionVaultError
      || !['written', 'same', 'stale'].includes(String(sessionVaultResult))
    ) {
      const vaultError = new Error(
        `session vault source write failed: ${
          sessionVaultError?.message ?? String(sessionVaultResult)
        }`,
      );
      // A paid capture remains authoritative even when token convenience
      // needs repair. The free offer is different: no durable reusable card,
      // no account creation and no entitlement.
      if (specialFreeOffer) throw vaultError;
      deferredVaultError = vaultError;
    }

    if (specialFreeOffer) {
      // `stale` means a strictly newer main checkout owns the session vault.
      // That is safe only when the database can prove the winner is itself a
      // canonical, nonterminal captured source with a reusable token. Once the
      // account is resolved below, promotion + the entitlement trigger queues
      // subscription/update-token for that newer generation. A false/error is
      // retryable: never complete a live provider subscription as an orphan.
      const { data: cardReady, error: cardReadyError } = await db.rpc(
        'solidgate_special_free_card_ready',
        { p_order_id: effectiveRow.id },
      );
      if (cardReadyError || cardReady !== true) {
        throw new Error(
          `special_free reusable card readiness check failed: ${
            cardReadyError?.message ?? String(cardReady)
          }`,
        );
      }
    }
  }

  // The buyer's account. Normally the grant route already made it; if that call
  // died, this is the only thing standing between a paying customer and no
  // account at all.
  let userId = effectiveRow.user_id as string | null;
  const session = binding.session;
  const email = binding.email;

  await consumeIntroOffer(db, {
    environment,
    orderId,
    productSlug: effectiveRow.product_slug,
    sessionId: effectiveRow.session_id,
    email,
    subscriptionId,
    metadata: orderMetadata,
  });

  if (!userId && email) {
    const resolved = await resolveOrCreateUser(db, email);
    if (resolved) {
      userId = resolved.userId;
      const { error: orderClaimError } = await db.from('orders').update({ user_id: userId, claimed_at: new Date().toISOString() })
        .eq('payment_environment', environment)
        .eq('solidgate_order_id', orderId).is('user_id', null);
      if (orderClaimError) throw new Error(`order ownership update failed: ${orderClaimError.message}`);
    }
  }

  // The order claim can commit while the following session claim fails. Retry
  // the missing link even when this invocation started with orders.user_id.
  if (userId && effectiveRow.session_id && session?.user_id !== userId) {
    const { data: claimedSession, error: sessionClaimError } = await db
      .from('sessions')
      .update({ user_id: userId })
      .eq('id', effectiveRow.session_id)
      .is('user_id', null)
      .select('id')
      .maybeSingle();
    if (sessionClaimError) {
      throw new Error(`session ownership update failed: ${sessionClaimError.message}`);
    }
    if (!claimedSession) {
      const { data: winner, error: winnerError } = await db.from('sessions')
        .select('user_id')
        .eq('id', effectiveRow.session_id)
        .maybeSingle();
      if (winnerError || winner?.user_id !== userId) {
        throw new Error('session ownership claim lost to a different user');
      }
    }
  }

  if (userId && effectiveRow.session_id) {
    try {
      await promoteSessionCardToAccount(db, {
        userId,
        sessionId: effectiveRow.session_id,
        paymentEnvironment: environment,
      });
    } catch (error) {
      deferredVaultError ??= error instanceof Error
        ? error
        : new Error(`account vault promotion failed: ${String(error)}`);
    }
  }

  // Entitlement. The grant route already did this for the happy path; this is
  // the backstop for the settle-later case, and it is idempotent.
  if (userId && effectiveRow.product_slug) {
    const entitlementGranted = await grantInitialSolidgateEntitlement(db, {
      row: effectiveRow,
      userId,
      // The authoritative subscription callback overwrites this with
      // next_charge_at. Seven days is the safe fallback for every current
      // Solidgate subscription (trial or direct weekly first period).
      expiresAt: initialSubscriptionExpiresAt,
      subscriptionId,
      environment,
      pwaDirectSubscription,
    });
    if (!entitlementGranted) {
      // A user-less order can only reveal a competing entitlement after the
      // account is resolved. Never ACK this recovery without the exact grant:
      // the provider subscription is already live and must remain retryable.
      if (recoveringTokenlessSpecialFree) {
        throw new Error('special_free tokenless recovery entitlement grant was rejected');
      }
      return;
    }
  }

  // Paid access is authoritative; a token-vault repair must never prevent the
  // grant. Throw only after the grant committed so Solidgate retries the event
  // and can repair the monotonic source on a later attempt.
  if (deferredVaultError) throw deferredVaultError;

  if (userId && isMainSubscription(effectiveRow.product_slug)) {
    await enqueueMainPurchaseEnrichment(db, {
      environment,
      orderId,
      userId,
      hasEmail: Boolean(email),
    });
  }

  // The lifetime effect cancels the replaced main subscription — never
  // enqueue it before the lifetime entitlement exists. With a resolved user
  // the grant ran above (a rejected grant returned before reaching here); a
  // user-less order defers the effect to the retry that resolves the buyer.
  if (userId || !isLifetime(effectiveRow.product_slug)) {
    await enqueueOtoFulfillment(db, {
      environment,
      orderId,
      sessionId: effectiveRow.session_id,
      productCode: effectiveRow.product_slug,
    });
  }

  // Server-side canonical purchase event. Fires for every paid
  // order — the client route only settles the happy path; this covers redirect
  // returns and settle-later too — and the row claim keeps it once per order.
  await enqueueOrderAnalytics(db, {
    orderId,
    productSlug: effectiveRow.product_slug,
    subscriptionId,
    amountCents: paidAmount,
    currency: order?.currency?.toLowerCase() ?? effectiveRow.currency ?? null,
    sessionId: effectiveRow.session_id,
    userId,
    email,
    locale: binding.checkoutLocale,
    // Keep one stable key across card/subscription callbacks and the PWA client.
    // payment_status still distinguishes a zero auth from a captured charge.
    eventKeySuffix: 'settled',
    paymentStatus: status,
    metadata: orderMetadata,
    solidgateProductId: binding.productId,
    solidgateProductName: null,
    priceId: binding.priceId,
  });
  await persistAccountAcquisition(db, {
    userId,
    sessionId: effectiveRow.session_id,
    orderRowId: effectiveRow.id,
    capturedAt: effectiveRow.created_at,
    environment,
    metadata: orderMetadata,
  });
  await enqueueIdentityMerge(db, userId, effectiveRow.session_id);
}

// ── subscription.updated.v2 ─────────────────────────────────────────────────

type SubscriptionOrderRow = {
  id: string;
  psp: string;
  payment_environment: string;
  solidgate_order_id: string;
  session_id: string | null;
  user_id: string | null;
  product_name: string;
  product_slug: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  solidgate_card_source_sequence: number;
  tracking_metadata?: unknown;
  status?: string;
  solidgate_original_amount_cents?: number | null;
  solidgate_subscription_id?: string | null;
  solidgate_payment_status?: string | null;
  solidgate_refunded_amount_cents?: number | null;
  solidgate_chargeback_id?: string | null;
  solidgate_chargeback_status?: string | null;
  solidgate_chargeback_amount_cents?: number | null;
  solidgate_customer_email: string | null;
  solidgate_checkout_locale: string | null;
  solidgate_product_id: string | null;
  solidgate_payment_action: string | null;
  solidgate_checkout_identity_legacy: boolean;
};

const SUBSCRIPTION_ORDER_COLUMNS =
  'id,psp,payment_environment,solidgate_order_id,session_id,user_id,product_name,product_slug,amount_cents,currency,created_at,solidgate_card_source_sequence,tracking_metadata,status,solidgate_original_amount_cents,solidgate_subscription_id,solidgate_payment_status,solidgate_refunded_amount_cents,solidgate_chargeback_id,solidgate_chargeback_status,solidgate_chargeback_amount_cents,solidgate_customer_email,solidgate_checkout_locale,solidgate_product_id,solidgate_payment_action,solidgate_checkout_identity_legacy';

type InitialSubscriptionInvoice = NonNullable<SubscriptionEvent['invoices']>[string];
type InitialSubscriptionInvoiceOrder = NonNullable<InitialSubscriptionInvoice['orders']>[string];

interface InitialSubscriptionReference {
  invoiceId: string;
  invoice: InitialSubscriptionInvoice;
  providerOrderId: string;
  providerOrder: InitialSubscriptionInvoiceOrder;
}

type FinancialLifecycleKind = 'positive' | 'dunning' | 'terminal';

const POSITIVE_SUBSCRIPTION_CALLBACKS = new Set([
  'active',
  'renew',
  'recurring',
  'restore',
  'resume',
]);
const DUNNING_SUBSCRIPTION_CALLBACKS = new Set([
  'redemption',
  'retry',
  'scheduled_for_retry',
]);
const TERMINAL_SUBSCRIPTION_CALLBACKS = new Set(['cancel', 'expire']);
const OBSERVATIONAL_SUBSCRIPTION_CALLBACKS = new Set([
  'pause',
  'pause_schedule.create',
  'pause_schedule.update',
  'pause_schedule.delete',
  'switch_product',
  'create',
  'payment_attempt',
  'order_update',
]);
const SUPPORTED_SUBSCRIPTION_CALLBACKS = new Set([
  ...POSITIVE_SUBSCRIPTION_CALLBACKS,
  ...DUNNING_SUBSCRIPTION_CALLBACKS,
  ...TERMINAL_SUBSCRIPTION_CALLBACKS,
  'scheduled_for_cancellation',
  ...OBSERVATIONAL_SUBSCRIPTION_CALLBACKS,
]);

function financialLifecycleKind(callbackType: string): FinancialLifecycleKind | null {
  if (POSITIVE_SUBSCRIPTION_CALLBACKS.has(callbackType)) return 'positive';
  if (DUNNING_SUBSCRIPTION_CALLBACKS.has(callbackType)) return 'dunning';
  if (TERMINAL_SUBSCRIPTION_CALLBACKS.has(callbackType)) return 'terminal';
  return null;
}

function isSupportedSubscriptionCallback(callbackType: unknown): callbackType is string {
  return typeof callbackType === 'string' && SUPPORTED_SUBSCRIPTION_CALLBACKS.has(callbackType);
}

function initialSubscriptionReferences(event: SubscriptionEvent): InitialSubscriptionReference[] {
  const references: InitialSubscriptionReference[] = [];
  for (const [invoiceMapId, invoice] of Object.entries(event.invoices ?? {})) {
    if (invoice.subscription_term_number !== 0) continue;
    const invoiceId = invoice.id ?? invoiceMapId;
    for (const [orderMapId, providerOrder] of Object.entries(invoice.orders ?? {})) {
      const providerOrderId = providerOrder.id ?? orderMapId;
      if (!providerOrderId) continue;
      references.push({ invoiceId, invoice, providerOrderId, providerOrder });
    }
  }
  return references;
}

function subscriptionMetadataEntries(value: unknown, label: string): Array<[string, string]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`initial subscription ${label} metadata is missing`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, candidate]) => typeof candidate !== 'string')) {
    throw new Error(`initial subscription ${label} metadata is invalid`);
  }
  return (entries as Array<[string, string]>).sort(([a], [b]) => a.localeCompare(b));
}

async function assertInitialSubscriptionBinding(
  db: SupabaseClient,
  event: SubscriptionEvent,
  row: SubscriptionOrderRow,
  reference: InitialSubscriptionReference,
  environment: PaymentEnvironment,
): Promise<void> {
  const trustedEntries = subscriptionMetadataEntries(row.tracking_metadata, 'trusted');
  const callbackEntries = subscriptionMetadataEntries(reference.invoice.order_metadata, 'callback');
  if (JSON.stringify(trustedEntries) !== JSON.stringify(callbackEntries)) {
    throw new Error('initial subscription metadata binding mismatch');
  }
  const metadata = Object.fromEntries(trustedEntries);
  const expectedAccountRef = row.session_id ?? (row.user_id ? `u-${row.user_id}` : null);
  const expectedCustomerAccountId = row.session_id ?? row.user_id;
  const expectedAmount = row.solidgate_original_amount_cents ?? row.amount_cents;
  const orderParts = row.solidgate_order_id.split(':');
  const expectedProductId = row.solidgate_product_id;

  if (
    row.psp !== 'solidgate'
    || row.payment_environment !== environment
    || !expectedAccountRef
    || !expectedCustomerAccountId
    || row.product_name !== row.product_slug
    || reference.providerOrderId !== row.solidgate_order_id
    || metadata.session_id !== expectedAccountRef
    || !metadata.product_slug
    || !metadata.funnel_code
    || !metadata.funnel_variant
    || !metadata.price_id
    || !UUID_PATTERN.test(metadata.price_id)
    || productTokenFromSlug(metadata.product_slug) !== productToken(row.product_slug)
    || orderParts.length !== 3
    || orderParts[0] !== expectedAccountRef
    || orderParts[1] !== metadata.product_slug
    || !/^[1-9][0-9]{0,8}$/.test(orderParts[2] ?? '')
    || row.solidgate_checkout_identity_legacy
    || typeof row.solidgate_customer_email !== 'string'
    || normalizedEmail(row.solidgate_customer_email) !== row.solidgate_customer_email
    || typeof row.solidgate_checkout_locale !== 'string'
    || !row.solidgate_checkout_locale
    || row.solidgate_payment_action !== (
      isMainSubscription(row.product_slug) && expectedAmount === 0
        ? 'auth_0_amount'
        : 'auth_settle'
    )
  ) {
    throw new Error('initial subscription canonical order binding mismatch');
  }

  if (
    !expectedProductId
    || event.product?.product_id !== expectedProductId
    || reference.invoice.product_price_id !== metadata.price_id
  ) {
    throw new Error('initial subscription catalog binding mismatch');
  }
  if (
    typeof event.product?.currency !== 'string'
    || event.product.currency.toLowerCase() !== row.currency.toLowerCase()
  ) {
    throw new Error('initial subscription currency binding mismatch');
  }
  if (
    !Number.isSafeInteger(expectedAmount)
    || expectedAmount < 0
    || reference.invoice.subscription_term_number !== 0
    || reference.invoice.amount !== expectedAmount
    || reference.providerOrder.amount !== expectedAmount
  ) {
    throw new Error('initial subscription amount binding mismatch');
  }

  const trustedEmail = row.solidgate_customer_email;
  if (row.session_id) {
    const { data: session, error } = await db.from('sessions')
      .select('user_id')
      .eq('id', row.session_id)
      .maybeSingle();
    if (error) throw new Error(`initial subscription session binding read failed: ${error.message}`);
    if (!session) throw new Error('initial subscription session binding mismatch');
    if (session.user_id != null && session.user_id !== row.user_id) {
      throw new Error('initial subscription session ownership binding mismatch');
    }
  }

  if (
    event.customer?.customer_account_id !== expectedCustomerAccountId
    || typeof event.customer?.customer_email !== 'string'
    || normalizedEmail(event.customer.customer_email) !== normalizedEmail(trustedEmail)
  ) {
    throw new Error('initial subscription customer binding mismatch');
  }
}

async function bindInitialSubscriptionOrder(
  db: SupabaseClient,
  row: SubscriptionOrderRow,
  subscriptionId: string,
  environment: PaymentEnvironment,
): Promise<SubscriptionOrderRow> {
  if (row.solidgate_subscription_id === subscriptionId) return row;
  if (row.solidgate_subscription_id) {
    throw new Error(`initial subscription order is already bound to another subscription`);
  }

  const { data: bound, error } = await db.from('orders')
    .update({ solidgate_subscription_id: subscriptionId })
    .eq('payment_environment', environment)
    .eq('id', row.id)
    .eq('solidgate_order_id', row.solidgate_order_id)
    .is('solidgate_subscription_id', null)
    .select(SUBSCRIPTION_ORDER_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`subscription binding update failed: ${error.message}`);
  if (bound) {
    return { ...(bound as SubscriptionOrderRow), solidgate_subscription_id: subscriptionId };
  }

  // A competing webhook may win the NULL -> subscription CAS. Only the exact
  // same subscription is a harmless replay; a different/no winner is retryable.
  const { data: winner, error: winnerError } = await db.from('orders')
    .select(SUBSCRIPTION_ORDER_COLUMNS)
    .eq('payment_environment', environment)
    .eq('id', row.id)
    .eq('solidgate_order_id', row.solidgate_order_id)
    .maybeSingle();
  if (winnerError) throw new Error(`subscription binding recovery read failed: ${winnerError.message}`);
  if (winner?.solidgate_subscription_id === subscriptionId) {
    return winner as SubscriptionOrderRow;
  }
  throw new Error(`subscription ${subscriptionId} binding lost without an exact durable winner`);
}

function latestInvoice(event: SubscriptionEvent) {
  const entries = Object.entries(event.invoices ?? {});
  if (entries.length === 0) return null;
  type Invoice = NonNullable<SubscriptionEvent['invoices']>[string];
  const timestamp = (invoice: Invoice) => {
    const normalized = isoSolidgateDate(invoice.updated_at ?? invoice.created_at);
    return normalized ? new Date(normalized).getTime() : Number.MIN_SAFE_INTEGER;
  };
  return entries.reduce((latest, candidate) => {
    const latestAt = timestamp(latest[1]);
    const candidateAt = timestamp(candidate[1]);
    if (candidateAt !== latestAt) return candidateAt > latestAt ? candidate : latest;

    const latestTerm = latest[1].subscription_term_number ?? -1;
    const candidateTerm = candidate[1].subscription_term_number ?? -1;
    if (candidateTerm !== latestTerm) return candidateTerm > latestTerm ? candidate : latest;

    // Final deterministic tie-breaker: provider invoice id, then map key.
    const latestId = latest[1].id ?? latest[0];
    const candidateId = candidate[1].id ?? candidate[0];
    return candidateId.localeCompare(latestId) > 0 ? candidate : latest;
  });
}

function isExactTerminalInitialCardFailure(
  row: SubscriptionOrderRow,
  subscriptionId: string,
): boolean {
  const originalAmount = row.solidgate_original_amount_cents;
  return (
    row.status === 'failed'
    && typeof originalAmount === 'number'
    && Number.isSafeInteger(originalAmount)
    && originalAmount >= 0
    && Number.isSafeInteger(row.amount_cents)
    && (row.amount_cents === 0 || row.amount_cents === originalAmount)
    && TERMINAL_INITIAL_CARD_FAILURE_STATUSES.has(row.solidgate_payment_status ?? '')
    && (row.solidgate_subscription_id == null || row.solidgate_subscription_id === subscriptionId)
    && (row.solidgate_refunded_amount_cents ?? 0) === 0
    && !row.solidgate_chargeback_id
    && !row.solidgate_chargeback_status
    && (row.solidgate_chargeback_amount_cents ?? 0) === 0
  );
}

async function resolveSubscriptionOrder(
  db: SupabaseClient,
  event: SubscriptionEvent,
  subscriptionId: string,
  callbackSupported: boolean,
  context?: WebhookContext,
): Promise<SubscriptionOrderRow | null> {
  const environment = paymentEnvironment(context);
  const { data: direct, error: directError } = await db
    .from('orders')
    .select(SUBSCRIPTION_ORDER_COLUMNS)
    .eq('payment_environment', environment)
    .eq('solidgate_subscription_id', subscriptionId)
    .maybeSingle();
  if (directError) throw new Error(`subscription order lookup failed: ${directError.message}`);
  if (direct) return direct as SubscriptionOrderRow;

  // The initial callback may beat card_gate.order.updated, but it may bind only
  // the exact merchant order named by a term-0 invoice. Session/newest-order
  // guessing cross-links retries and is intentionally forbidden.
  const references = initialSubscriptionReferences(event);
  const metadataCandidates = Object.values(event.invoices ?? {})
    .filter((invoice) => invoice.subscription_term_number === 0)
    .map((invoice) => stringMetadata(invoice.order_metadata));
  // Unconfigured catalog ids are dropped: an empty string must never make an
  // event with a blank product_id look like ours.
  const productIds = new Set(
    Object.values(INITIAL_SUBSCRIPTION_PRODUCT_IDS).filter((id) => id.length > 0),
  );
  const metadataIsOurs = metadataCandidates.some((metadata) =>
    isOurProduct(metadata.product_code)
    || productTokenFromSlug(metadata.product_slug ?? metadata.tier) !== null
  );
  const productIsOurs = typeof event.product?.product_id === 'string'
    && productIds.has(event.product.product_id);
  const accountRef = metadataCandidates.find((metadata) => metadata.session_id)?.session_id
    ?? event.customer?.customer_account_id
    ?? null;
  const accountIsPwaMember = Boolean(accountRef?.startsWith('u-'));
  let accountIsOurs = false;
  if (accountRef && !accountRef.startsWith('u-')) {
    const { data: ownSession, error: ownSessionError } = await db.from('sessions')
      .select('id')
      .eq('id', accountRef)
      .maybeSingle();
    if (ownSessionError) {
      throw new Error(`subscription session ownership lookup failed: ${ownSessionError.message}`);
    }
    accountIsOurs = Boolean(ownSession);
  }
  const appearsOurs = metadataIsOurs || productIsOurs || accountIsOurs;
  if (references.length === 0) {
    if (!appearsOurs) return null;

    // Term zero is the only binder, and the direct subscription-id lookup above
    // already proved nothing is bound. Renewal/dunning callbacks for a
    // subscription whose initial order lives outside this database — a
    // pre-cutover cohort on the same Solidgate merchant — carry no term-0
    // invoice at all, so no redelivery can ever produce one. Retrying is
    // provably futile and only buries the failures that can still heal, so ACK
    // instead. Nothing is discarded: the raw payload stays in
    // solidgate_webhook_events.
    //
    // Two neighbouring cases must still fail closed, so both are excluded:
    //  - a term-0 invoice that is present but carries no order id — an
    //    incomplete payload a later redelivery can complete;
    //  - anything with a local anchor. Only a shared catalog product id may
    //    link an unbindable subscription to us; a known session, our own
    //    trusted metadata, or a `u-<uid>` PWA account all mean a local order
    //    should exist, and a wrong term number there is contract drift.
    const carriesTermZeroInvoice = Object.values(event.invoices ?? {})
      .some((invoice) => invoice.subscription_term_number === 0);
    const onlyCatalogProductLinksUs = productIsOurs
      && !metadataIsOurs
      && !accountIsOurs
      && !accountIsPwaMember;
    if (!carriesTermZeroInvoice && onlyCatalogProductLinksUs) {
      console.info('[solidgate-webhooks] unbindable subscription callback acknowledged', {
        subscriptionId,
        callbackType: event.callback_type ?? '',
        terms: Object.values(event.invoices ?? {})
          .map((invoice) => invoice.subscription_term_number ?? null),
      });
      return null;
    }

    throw new Error(`subscription ${subscriptionId} has no exact term-0 order binding`);
  }

  const eventOrderIds = [...new Set(references.map((reference) => reference.providerOrderId))];
  const { data: matches, error: matchError } = await db.from('orders')
    .select(SUBSCRIPTION_ORDER_COLUMNS)
    .eq('psp', 'solidgate')
    .eq('payment_environment', environment)
    .in('solidgate_order_id', eventOrderIds);
  if (matchError) throw new Error(`subscription order-id lookup failed: ${matchError.message}`);
  if (!matches || matches.length === 0) {
    if (appearsOurs) throw new Error(`subscription ${subscriptionId} exact term-0 order is not ready`);
    return null;
  }
  if (matches.length !== 1) {
    throw new Error(`subscription ${subscriptionId} has ambiguous term-0 order bindings`);
  }

  const candidate = matches[0] as SubscriptionOrderRow;
  const candidateReferences = references.filter((reference) =>
    reference.providerOrderId === candidate.solidgate_order_id
  );
  if (candidateReferences.length !== 1) {
    throw new Error(`subscription ${subscriptionId} has ambiguous initial invoice evidence`);
  }
  const reference = candidateReferences[0];

  // Solidgate omits `order_metadata` from the create/expire callbacks emitted
  // for some rejected initial authorizations. Keep retrying while the card
  // result is pending, but once the exact order has a complete terminal-failure
  // snapshot there is no money or access state left for this callback to
  // change. ACK it without binding the dead subscription or creating side
  // effects, instead of turning every provider redelivery into a noisy 5xx.
  if (
    reference.invoice.order_metadata == null
    && isExactTerminalInitialCardFailure(candidate, subscriptionId)
  ) {
    // An unknown callback still represents contract drift for an exact local
    // order. Return the read-only ownership evidence so handleSubscription can
    // fail it without binding this dead subscription or performing any writes.
    if (!callbackSupported) return candidate;
    console.info('[solidgate-webhooks] initial subscription callback ignored after terminal card failure', {
      subscriptionId,
      callbackType: event.callback_type ?? '',
      providerOrderId: reference.providerOrderId,
      paymentStatus: candidate.solidgate_payment_status,
    });
    return null;
  }

  await assertInitialSubscriptionBinding(db, event, candidate, reference, environment);

  // Lifecycle callbacks are not capture proof. For every branch that can
  // change money/access state, the card finalizer alone owns the initial
  // subscription binding, captured order status, user and entitlement. This
  // callback remains read-only and is retried after those writes are durable.
  if (!callbackSupported || financialLifecycleKind(event.callback_type ?? '')) return candidate;

  return bindInitialSubscriptionOrder(db, candidate, subscriptionId, environment);
}

type SubscriptionLifecycleDisposition = 'apply' | 'already_applied' | 'ignore_terminal';

type SubscriptionEntitlementRow = {
  order_id?: string | null;
  user_id?: string | null;
  product_slug?: string | null;
  solidgate_subscription_id?: string | null;
  status?: string | null;
  revoked_at?: string | null;
};

const FINALIZED_SUBSCRIPTION_ORDER_STATUSES = new Set([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'refunded',
  'disputed',
]);

function nonLifecycleTerminalOrder(row: SubscriptionOrderRow): boolean {
  return (
    row.status === 'refunded' ||
    row.status === 'disputed' ||
    row.solidgate_payment_status === 'void_ok' ||
    Boolean(row.solidgate_chargeback_id) ||
    Boolean(row.solidgate_chargeback_status) ||
    (row.solidgate_chargeback_amount_cents ?? 0) > 0
  );
}

async function assertInitialSubscriptionCardFinalized(
  db: SupabaseClient,
  row: SubscriptionOrderRow,
  subscriptionId: string,
  environment: PaymentEnvironment,
  lifecycleKind: FinancialLifecycleKind,
): Promise<{
  row: SubscriptionOrderRow;
  disposition: SubscriptionLifecycleDisposition;
}> {
  // Re-read by the immutable local order identity. The card webhook can win
  // between the term-0 lookup above and this query; accepting that exact
  // durable winner avoids an unnecessary provider redelivery, while a pending
  // or differently-bound row still fails closed without a business mutation.
  const { data: durableData, error: durableError } = await db.from('orders')
    .select(SUBSCRIPTION_ORDER_COLUMNS)
    .eq('payment_environment', environment)
    .eq('id', row.id)
    .eq('solidgate_order_id', row.solidgate_order_id)
    .maybeSingle();
  if (durableError) {
    throw new Error(`initial subscription order finalization read failed: ${durableError.message}`);
  }
  if (!durableData) {
    throw new Error(`subscription ${subscriptionId} is waiting for card settlement finalization`);
  }
  const durable = durableData as SubscriptionOrderRow;
  const sameImmutableOrder =
    durable.id === row.id
    && durable.psp === 'solidgate'
    && durable.payment_environment === environment
    && durable.solidgate_order_id === row.solidgate_order_id
    && durable.session_id === row.session_id
    && durable.product_name === row.product_name
    && durable.product_slug === row.product_slug
    && durable.amount_cents === row.amount_cents
    && durable.currency.toLowerCase() === row.currency.toLowerCase()
    && durable.created_at === row.created_at
    && JSON.stringify(subscriptionMetadataEntries(durable.tracking_metadata, 'durable')) ===
      JSON.stringify(subscriptionMetadataEntries(row.tracking_metadata, 'candidate'));

  // A signed lifecycle callback may follow the card callback that conclusively
  // rejected the exact term-0 order. There is no captured money or entitlement
  // to cancel/dun, so retrying forever cannot make the missing grant appear.
  // ACK only after the card finalizer's complete, internally consistent failure
  // snapshot is durable; a pending/partial/mismatched row still fails closed.
  const exactTerminalInitialCardFailure =
    sameImmutableOrder
    && isExactTerminalInitialCardFailure(durable, subscriptionId);
  if (exactTerminalInitialCardFailure) {
    return { row: durable, disposition: 'ignore_terminal' };
  }

  const expectedAmount = durable.solidgate_original_amount_cents ?? durable.amount_cents;
  const captureStatus = durable.solidgate_payment_status ?? '';
  // A partial refund preserves the captured purchase and its subscription.
  // The provider now reports `refunded`, so requiring settle_ok forever would
  // reject every later paid renewal. Only an exact, positive remaining balance
  // proves this case; full refunds and inconsistent money remain blocked.
  const refundedAmount = durable.solidgate_refunded_amount_cents ?? 0;
  const partiallyRefundedCapture = captureStatus === 'refunded'
    && Number.isSafeInteger(refundedAmount)
    && refundedAmount > 0
    && refundedAmount < expectedAmount
    && Number.isSafeInteger(durable.amount_cents)
    && durable.amount_cents === expectedAmount - refundedAmount;
  const captureProven = expectedAmount === 0
    ? captureStatus === 'auth_ok' || SETTLED_ORDER_STATUSES.has(captureStatus)
    : SETTLED_ORDER_STATUSES.has(captureStatus) || partiallyRefundedCapture;
  if (
    !sameImmutableOrder
    || !FINALIZED_SUBSCRIPTION_ORDER_STATUSES.has(durable.status ?? '')
    || durable.solidgate_subscription_id !== subscriptionId
    || !durable.user_id
    || !Number.isSafeInteger(expectedAmount)
    || expectedAmount < 0
    || durable.solidgate_original_amount_cents !== expectedAmount
    || !captureProven
  ) {
    throw new Error(`subscription ${subscriptionId} is waiting for card settlement finalization`);
  }

  const { data: entitlement, error } = await db.from('entitlements')
    .select('order_id,user_id,product_slug,solidgate_subscription_id,status,revoked_at')
    .eq('payment_environment', environment)
    .eq('user_id', durable.user_id)
    .eq('product_slug', durable.product_slug)
    .maybeSingle();
  if (error) throw new Error(`initial subscription entitlement binding read failed: ${error.message}`);
  const entitlementRow = entitlement as SubscriptionEntitlementRow | null;
  if (entitlementRow?.order_id && entitlementRow.order_id !== durable.id) {
    const { data: owner, error: ownerError } = await db.from('orders')
      .select('id,created_at,solidgate_card_source_sequence')
      .eq('payment_environment', environment)
      .eq('id', entitlementRow.order_id)
      .maybeSingle();
    if (ownerError) {
      throw new Error(`replacement subscription entitlement owner read failed: ${ownerError.message}`);
    }
    if (
      owner
      && (
        (
          isMainSubscription(durable.product_slug)
          && new Date(owner.created_at).getTime() >= new Date(durable.created_at).getTime()
        )
        || (
          !isMainSubscription(durable.product_slug)
          && (
            new Date(owner.created_at).getTime() > new Date(durable.created_at).getTime()
            || (
              owner.created_at === durable.created_at
              && owner.id.localeCompare(durable.id) >= 0
            )
          )
        )
      )
    ) {
      return { row: durable, disposition: 'ignore_terminal' };
    }
    throw new Error(`subscription ${subscriptionId} entitlement has an unexplained owner`);
  }
  const activeEntitlement = entitlementRow?.status === 'active' && !entitlementRow.revoked_at;
  const pastDueEntitlement = entitlementRow?.status === 'past_due' && !entitlementRow.revoked_at;
  const canceledEntitlement = entitlementRow?.status === 'canceled' && Boolean(entitlementRow.revoked_at);
  if (
    !entitlementRow
    || entitlementRow.order_id !== durable.id
    || entitlementRow.user_id !== durable.user_id
    || entitlementRow.product_slug !== durable.product_slug
    || entitlementRow.solidgate_subscription_id !== subscriptionId
    || (!activeEntitlement && !pastDueEntitlement && !canceledEntitlement)
  ) {
    throw new Error(`subscription ${subscriptionId} is waiting for captured entitlement finalization`);
  }

  // A financial reversal always outranks lifecycle delivery. Likewise, an
  // equal-time positive/dunning callback delivered after a cancellation must
  // never reopen access or rewrite the terminal order.
  if (
    nonLifecycleTerminalOrder(durable)
    || (
      lifecycleKind !== 'terminal'
      && (durable.status === 'canceled' || canceledEntitlement)
    )
  ) {
    return { row: durable, disposition: 'ignore_terminal' };
  }

  // Fully-applied replays are acknowledged without extending a fresh grace
  // window or repeatedly touching terminal rows. Partial writes still fall
  // through to the idempotent branch so redelivery repairs them.
  if (
    lifecycleKind === 'terminal'
    && durable.status === 'canceled'
    && canceledEntitlement
  ) {
    return { row: durable, disposition: 'already_applied' };
  }
  if (
    lifecycleKind === 'dunning'
    && durable.status === 'past_due'
    && pastDueEntitlement
  ) {
    return { row: durable, disposition: 'already_applied' };
  }

  return { row: durable, disposition: 'apply' };
}

const SUBSCRIPTION_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Positive lifecycle callbacks must never turn a subscription entitlement into
 * unbounded access. The successful invoice's billing period is the access
 * promise; next_charge_at is a payment schedule and can differ from it.
 * Older payloads without that period retain a bounded next-charge/cadence
 * fallback, anchored to the invoice so later callbacks cannot mint more time.
 */
function positiveSubscriptionExpiry(
  event: SubscriptionEvent,
  invoice: InitialSubscriptionInvoice | undefined,
  productSlug: string,
  context?: WebhookContext,
): string {
  // `active` also accompanies paid terms. The term/trial facts, rather than
  // the callback name alone, decide whether this is the introductory period.
  const term = invoice?.subscription_term_number;
  const initialPeriod = term === 0 || (term == null && event.subscription?.trial === true);
  const cadenceDays = isRecurringAddon(productSlug) || initialPeriod ? 7 : 30;
  const maximumProviderDays = isRecurringAddon(productSlug) || initialPeriod ? 14 : 45;
  const periodStart = isoSolidgateDate(invoice?.billing_period_started_at);
  const periodEnd = isoSolidgateDate(invoice?.billing_period_ended_at);
  const anchorCandidates = [
    periodStart,
    isoSolidgateDate(invoice?.created_at),
    isoSolidgateDate(context?.eventCreatedAt),
    // A subscription may have started months before this paid renewal.
    initialPeriod ? isoSolidgateDate(event.subscription?.started_at) : null,
  ];
  const anchor = anchorCandidates.find((candidate): candidate is string => Boolean(candidate));
  const anchorMs = anchor ? new Date(anchor).getTime() : Date.now();

  if (periodStart && periodEnd) {
    const duration = Date.parse(periodEnd) - Date.parse(periodStart);
    if (duration > 0 && duration <= maximumProviderDays * SUBSCRIPTION_DAY_MS) {
      return periodEnd;
    }
  }
  const providerNextCharge = isoSolidgateDate(event.subscription?.next_charge_at);
  if (providerNextCharge) {
    const providerMs = new Date(providerNextCharge).getTime();
    if (
      providerMs > anchorMs
      && providerMs <= anchorMs + maximumProviderDays * SUBSCRIPTION_DAY_MS
    ) {
      return providerNextCharge;
    }
  }
  return new Date(anchorMs + cadenceDays * SUBSCRIPTION_DAY_MS).toISOString();
}

const RENEWAL_CALLBACKS = new Set([
  'active',
  'renew',
  'recurring',
  'restore',
  'resume',
  'switch_product',
]);

/**
 * A newer bookkeeping callback can overtake `renew` and advance the entity
 * watermark. Project its paid term as well, or the now-stale renew would leave
 * access at the previous expiry forever. Initial/auth-only and inactive
 * snapshots remain observational; they are not initial capture proof.
 */
function isPaidRenewalSnapshot(
  event: SubscriptionEvent,
  invoice: InitialSubscriptionInvoice | undefined,
  row: SubscriptionOrderRow,
): boolean {
  if (
    !['order_update', 'scheduled_for_cancellation'].includes(event.callback_type ?? '')
    || event.subscription?.status !== 'active'
    || event.product?.product_id !== row.solidgate_product_id
    || event.product?.currency?.toLowerCase() !== row.currency.toLowerCase()
    || invoice?.status !== 'success'
    || !Number.isSafeInteger(invoice.subscription_term_number)
    || (invoice.subscription_term_number ?? 0) <= 0
    || !Number.isSafeInteger(invoice.amount)
    || (invoice.amount ?? 0) <= 0
  ) return false;
  const orders = Object.values(invoice.orders ?? {});
  return !orders.some((order) => ['refunded', 'void_ok'].includes(order.status ?? ''))
    && orders.some((order) =>
      ['settle_ok', 'approved', 'partial_settled'].includes(order.status ?? '')
      && order.amount === invoice.amount
    );
}

async function renewalSnapshotWasReversed(
  db: SupabaseClient,
  invoiceId: string,
  subscriptionId: string,
  environment: PaymentEnvironment,
): Promise<boolean> {
  const { data: renewal, error } = await db.from('renewal_events')
    .select('status')
    .eq('payment_environment', environment)
    .eq('solidgate_invoice_id', invoiceId)
    .eq('solidgate_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw new Error(`renewal snapshot reversal read failed: ${error.message}`);
  if (renewal && renewal.status !== 'paid') return true;

  // A card reversal can arrive before the successful subscription snapshot has
  // created renewal_events. Preserve that durable evidence too.
  const { data: orders, error: ordersError } = await db.from('solidgate_invoice_orders')
    .select('status,refunded_amount_cents,chargeback_id,chargeback_status,chargeback_amount_cents')
    .eq('environment', environment)
    .eq('solidgate_invoice_id', invoiceId)
    .eq('solidgate_subscription_id', subscriptionId);
  if (ordersError) throw new Error(`renewal snapshot order reversal read failed: ${ordersError.message}`);
  return (orders ?? []).some((order) =>
    ['refunded', 'void_ok'].includes(order.status)
    || order.refunded_amount_cents > 0
    || order.chargeback_id
    || order.chargeback_status
    || order.chargeback_amount_cents > 0
  );
}

/**
 * Success for one provider invoice/term is economically final even when a
 * same-timestamp dunning callback arrives later. Positive renewal processing
 * records `renewal_events` before changing access, so this exact durable key
 * gives both arrival orders the same final result. Term zero is already proven
 * paid by the initial-card gate above.
 */
async function dunningSupersededByPaidInvoice(
  db: SupabaseClient,
  event: SubscriptionEvent,
  context?: WebhookContext,
): Promise<boolean> {
  const invoiceEntry = latestInvoice(event);
  if (!invoiceEntry) return false;
  const [invoiceMapId, invoice] = invoiceEntry;
  const invoiceId = invoice.id ?? invoiceMapId;
  const term = invoice.subscription_term_number;
  const subscriptionId = event.subscription?.id;
  if (!invoiceId || term == null || !subscriptionId) return false;

  if (term === 0) return true;

  const carriesSuccessfulSettlement = invoice.status === 'success'
    && Object.values(invoice.orders ?? {}).some((order) =>
      order.status === 'settle_ok'
      || order.status === 'approved'
      || order.status === 'partial_settled'
    );
  if (carriesSuccessfulSettlement) return true;

  const { data, error } = await db.from('renewal_events')
    .select('status')
    .eq('payment_environment', paymentEnvironment(context))
    .eq('solidgate_invoice_id', invoiceId)
    .eq('solidgate_subscription_id', subscriptionId)
    .eq('subscription_term_number', term)
    .maybeSingle();
  if (error) throw new Error(`paid renewal precedence read failed: ${error.message}`);
  return data?.status === 'paid';
}

async function recordSubscriptionInvoices(
  db: SupabaseClient,
  event: SubscriptionEvent,
  row: SubscriptionOrderRow,
  callbackType: string,
  context?: WebhookContext,
  locale?: string | null,
): Promise<void> {
  const subscriptionId = event.subscription?.id;
  if (!subscriptionId) return;
  const environment = paymentEnvironment(context);
  const currency = (event.product?.currency ?? row.currency ?? 'eur').toLowerCase();
  const currentInvoice = latestInvoice(event)?.[1];

  for (const [invoiceMapId, invoice] of Object.entries(event.invoices ?? {})) {
    const invoiceId = invoice.id ?? invoiceMapId;
    if (!invoiceId) continue;
    const term = invoice.subscription_term_number ?? null;
    const invoiceCreatedAt = isoSolidgateDate(invoice.created_at);
    const metadata = invoice.order_metadata ?? {};
    const orderEntries = Object.entries(invoice.orders ?? {});

    for (const [orderMapId, invoiceOrder] of orderEntries) {
      const recurringOrderId = invoiceOrder.id ?? orderMapId;
      if (!recurringOrderId) continue;
      const { error } = await db.from('solidgate_invoice_orders').upsert(
        {
          environment,
          solidgate_order_id: recurringOrderId,
          solidgate_invoice_id: invoiceId,
          solidgate_subscription_id: subscriptionId,
          subscription_term_number: term,
          status: invoiceOrder.status ?? invoice.status ?? 'processing',
          amount_cents: invoiceOrder.amount ?? invoice.amount ?? 0,
          currency,
          operation: invoiceOrder.operation ?? null,
          product_price_id: invoice.product_price_id ?? metadata.price_id ?? null,
          order_metadata: metadata,
          source_created_at: isoSolidgateDate(invoiceOrder.created_at),
          source_updated_at: isoSolidgateDate(invoiceOrder.updated_at),
          event_created_at: context?.eventCreatedAt ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'environment,solidgate_order_id', ignoreDuplicates: true },
      );
      if (error) throw new Error(`recurring order ledger upsert failed: ${error.message}`);
    }

    const successfulOrder = orderEntries.find(([, order]) =>
      order.status === 'settle_ok' || order.status === 'approved' || order.status === 'partial_settled'
    );
    const renewal = invoice.status === 'success'
      && (RENEWAL_CALLBACKS.has(callbackType)
        || (invoice === currentInvoice && isPaidRenewalSnapshot(event, invoice, row)))
      && term !== 0;
    if (!renewal || (invoice.amount ?? 0) <= 0) continue;

    const renewalOrderId = successfulOrder?.[1]?.id ?? successfulOrder?.[0] ?? null;
    const { error: renewalError } = await db.from('renewal_events').upsert(
      {
        payment_environment: environment,
        solidgate_invoice_id: invoiceId,
        solidgate_subscription_id: subscriptionId,
        solidgate_order_id: renewalOrderId,
        subscription_term_number: term,
        amount_cents: invoice.amount ?? 0,
        gross_amount_cents: invoice.amount ?? 0,
        refunded_amount_cents: 0,
        status: 'paid',
        currency,
        product_key: row.product_slug,
        invoice_created_at: invoiceCreatedAt,
        event_created_at: context?.eventCreatedAt ?? null,
        ...(invoiceCreatedAt && { created_at: invoiceCreatedAt }),
      },
      { onConflict: 'payment_environment,solidgate_invoice_id', ignoreDuplicates: true },
    );
    if (renewalError) throw new Error(`renewal ledger upsert failed: ${renewalError.message}`);

    const canonicalProductSlug = metadata.product_slug ?? metadata.tier ??
      slugFromCode(row.product_slug) ?? row.product_slug;
    const priceId = invoice.product_price_id ?? metadata.price_id ?? null;
    await enqueueAnalytics(db, {
      eventKey: `renewal:${invoiceId}:paid`,
      eventName: 'subscription_renewed',
      distinctId: row.session_id ?? row.user_id ?? subscriptionId,
      properties: {
        provider: 'solidgate',
        payment_provider: 'solidgate',
        environment: context?.environment ?? runtime.environment,
        billing_type: 'subscription_renewal',
        session_id: row.session_id,
        user_id: row.user_id,
        product_slug: canonicalProductSlug,
        product_code: metadata.product_code ?? row.product_slug,
        product_id: metadata.product_id ?? metadata.product_code ?? row.product_slug,
        solidgate_product_id: event.product?.product_id,
        solidgate_product_name: event.product?.name,
        product_name: canonicalProductName(
          canonicalProductSlug,
          event.product?.name ?? metadata.product_name,
        ),
        product: canonicalProductSlug,
        amount_cents: invoice.amount ?? 0,
        revenue: invoice.amount ?? 0,
        currency: currency.toUpperCase(),
        solidgate_order_id: renewalOrderId,
        order_id: renewalOrderId,
        transaction_id: renewalOrderId,
        solidgate_invoice_id: invoiceId,
        solidgate_subscription_id: subscriptionId,
        subscription_term_number: term,
        price_id: priceId,
        solidgate_price_id: priceId,
        locale: locale ?? metadata.locale ?? null,
        funnel_code: metadata.funnel_code,
        funnel_variant: trackingFunnelVariant(metadata),
        tier: metadata.tier ?? metadata.product_slug,
        utm_source: metadata.utm_source,
        utm_medium: metadata.utm_medium,
        utm_campaign: metadata.utm_campaign,
        utm_content: metadata.utm_content,
        utm_term: metadata.utm_term,
      },
    });
  }
}

async function handleSubscription(
  db: SupabaseClient,
  event: SubscriptionEvent,
  context?: WebhookContext,
): Promise<void> {
  const callbackType = event.callback_type ?? '';
  const callbackSupported = isSupportedSubscriptionCallback(event.callback_type);
  const sub = event.subscription;
  const subscriptionId = sub?.id;
  if (!subscriptionId) return;

  const environment = paymentEnvironment(context);
  let row = await resolveSubscriptionOrder(
    db,
    event,
    subscriptionId,
    callbackSupported,
    context,
  );
  if (!row || !isOurProduct(row.product_slug)) {
    console.log('[solidgate-webhooks] subscription not ours, ignoring', { subscriptionId, callbackType });
    return;
  }
  if (!callbackSupported) {
    const callbackLabel = typeof event.callback_type === 'string' && event.callback_type.trim()
      ? event.callback_type
      : '<missing or malformed>';
    throw new Error(`unsupported subscription callback_type: ${callbackLabel}`);
  }

  const invoiceEntry = latestInvoice(event);
  const invoice = invoiceEntry?.[1];
  const paidRenewalSnapshot = isPaidRenewalSnapshot(event, invoice, row);
  if (paidRenewalSnapshot && await renewalSnapshotWasReversed(
    db, invoice!.id ?? invoiceEntry![0], subscriptionId, environment,
  )) return;
  const lifecycleKind = financialLifecycleKind(callbackType) ?? (paidRenewalSnapshot ? 'positive' : null);
  let lifecycleAlreadyApplied = false;
  if (lifecycleKind) {
    const finalized = await assertInitialSubscriptionCardFinalized(
      db,
      row,
      subscriptionId,
      environment,
      lifecycleKind,
    );
    row = finalized.row;
    if (finalized.disposition === 'ignore_terminal') return;
    lifecycleAlreadyApplied = finalized.disposition === 'already_applied';
  }

  if (
    lifecycleKind === 'dunning'
    && await dunningSupersededByPaidInvoice(db, event, context)
  ) return;

  const { data: session, error: sessionError } = row.session_id
    ? await db.from('sessions').select('user_id').eq('id', row.session_id).maybeSingle()
    : { data: null, error: null };
  if (sessionError) throw new Error(`subscription session lookup failed: ${sessionError.message}`);
  const userId = row.user_id ?? session?.user_id ?? null;
  const analyticsLocale = row.solidgate_checkout_locale;

  await recordSubscriptionInvoices(db, event, row, callbackType, context, analyticsLocale);
  await enqueueIdentityMerge(db, userId, row.session_id);

  const productSlug = row.product_slug as string;
  const invoiceId = invoice?.id ?? invoiceEntry?.[0] ?? null;
  const invoiceMetadata = {
    ...stringMetadata(row.tracking_metadata),
    ...(invoice?.order_metadata ?? {}),
  };
  const canonicalProductSlug = invoiceMetadata.product_slug ?? invoiceMetadata.tier ??
    slugFromCode(productSlug) ?? productSlug;
  const priceId = invoice?.product_price_id ?? invoiceMetadata.price_id ?? null;
  const commonAnalytics = {
    provider: 'solidgate',
    payment_provider: 'solidgate',
    environment: context?.environment ?? runtime.environment,
    session_id: row.session_id,
    user_id: userId,
    product_slug: canonicalProductSlug,
    product: canonicalProductSlug,
    product_code: invoiceMetadata.product_code ?? productSlug,
    product_id: invoiceMetadata.product_id ?? invoiceMetadata.product_code ?? productSlug,
    solidgate_product_id: event.product?.product_id,
    solidgate_product_name: event.product?.name,
    product_name: canonicalProductName(
      canonicalProductSlug,
      event.product?.name ?? invoiceMetadata.product_name,
    ),
    solidgate_subscription_id: subscriptionId,
    solidgate_invoice_id: invoiceId,
    subscription_term_number: invoice?.subscription_term_number ?? null,
    price_id: priceId,
    solidgate_price_id: priceId,
    locale: analyticsLocale ?? invoiceMetadata.locale ?? null,
    funnel_code: invoiceMetadata.funnel_code,
    funnel_variant: trackingFunnelVariant(invoiceMetadata),
    tier: invoiceMetadata.tier ?? invoiceMetadata.product_slug,
    utm_source: invoiceMetadata.utm_source,
    utm_medium: invoiceMetadata.utm_medium,
    utm_campaign: invoiceMetadata.utm_campaign,
    utm_content: invoiceMetadata.utm_content,
    utm_term: invoiceMetadata.utm_term,
  };

  // Preserve cancellation intent even when its paid invoice repairs a missed
  // renewal. The access mutation below never cancels ahead of the paid end.
  if (callbackType === 'scheduled_for_cancellation') {
    await enqueueAnalytics(db, {
      eventKey: `subscription:${subscriptionId}:cancellation-scheduled`,
      eventName: 'subscription_cancellation_scheduled',
      distinctId: row.session_id ?? userId ?? subscriptionId,
      properties: {
        ...commonAnalytics,
        billing_type: 'subscription_lifecycle',
        callback_type: callbackType,
        cancel_code: sub?.cancel_code ?? null,
        cancel_message: sub?.cancel_message ?? null,
      },
    });
  }

  switch (paidRenewalSnapshot ? 'renew' : callbackType) {
    // First successful charge, and every renewal after it.
    case 'active':
    case 'renew':
    case 'recurring':
    case 'restore':
    case 'resume': {
      const paid = invoice?.status === 'success';
      // `restore` and `recurring` are allowed to carry fail/processing invoice
      // states. Subscription.status may still say active, but money did not
      // succeed; never reactivate access from that optimistic outer status.
      if (!paid) return;

      if (
        terminalOrderPreventsGrant(row) ||
        await originalEntitlementWasRevoked(db, row.id, environment)
      ) {
        return;
      }

      await consumeIntroOffer(db, {
        environment,
        orderId: row.solidgate_order_id,
        productSlug,
        sessionId: row.session_id,
        email: row.solidgate_customer_email,
        subscriptionId,
        metadata: invoiceMetadata,
      });
      await persistAccountAcquisition(db, {
        userId,
        sessionId: row.session_id,
        orderRowId: row.id,
        capturedAt: row.created_at,
        environment,
        metadata: invoiceMetadata,
      });

      const { error: orderUpdateError } = await db
        .from('orders')
        .update({ status: sub?.trial ? 'trialing' : 'active' })
        .eq('payment_environment', environment)
        .eq('solidgate_subscription_id', subscriptionId);
      if (orderUpdateError) {
        throw new Error(`subscription activation update failed: ${orderUpdateError.message}`);
      }

      if (userId) {
        const expiresAt = positiveSubscriptionExpiry(event, invoice, productSlug, context);
        const lifecycleApplied = await applySolidgateSubscriptionLifecycle(db, {
          row,
          userId,
          // Access runs through the paid invoice period, with next-charge and
          // bounded cadence fallbacks for older payloads lacking period dates.
          accessLevel: sub?.trial ? 'trial' : 'full',
          expiresAt,
          subscriptionId,
          source: `solidgate_${callbackType}`,
          status: 'active',
          environment,
        });
        if (!lifecycleApplied) return;
      }

      // Backstop for card_gate.order.updated arriving late/missing. The outbox
      // key is identical to the card/PWA path, so either callback may win.
      if (callbackType === 'active' && paid && row.solidgate_order_id) {
        const invoiceOrder = Object.values(invoice?.orders ?? {}).find((order) =>
          order.status === 'settle_ok' || order.status === 'approved' || order.status === 'auth_ok'
        );
        await enqueueOrderAnalytics(db, {
          orderId: row.solidgate_order_id,
          productSlug,
          subscriptionId,
          amountCents: invoice?.amount ?? 0,
          currency: (event.product?.currency ?? row.currency ?? '').toLowerCase(),
          sessionId: row.session_id,
          userId,
          email: row.solidgate_customer_email,
          locale: row.solidgate_checkout_locale,
          eventKeySuffix: 'settled',
          paymentStatus: invoiceOrder?.status ?? 'subscription_active',
          metadata: invoice?.order_metadata,
          solidgateProductId: event.product?.product_id ?? null,
          solidgateProductName: event.product?.name ?? null,
          priceId: invoice?.product_price_id ?? null,
        });
      }

      if (callbackType === 'active' && userId) {
        await provisionMemberArea(userId, row.solidgate_checkout_locale);
      }
      return;
    }

    // Dunning. Solidgate keeps retrying while the subscription sits in
    // `redemption`, so the buyer must NOT lose access here — that is what the
    // grace window is for. The recurring add-on is the exception: it bills on a
    // much shorter cadence and costs us money per use, so it is cut immediately.
    case 'redemption':
    case 'retry':
    case 'scheduled_for_retry': {
      // Same-timestamp lifecycle callbacks can be delivered out of order. A
      // late dunning event must never resurrect a terminal order/entitlement.
      if (
        !lifecycleAlreadyApplied
        && (
          terminalOrderPreventsGrant(row)
          || await originalEntitlementWasRevoked(db, row.id, environment)
        )
      ) {
        return;
      }
      if (!lifecycleAlreadyApplied) {
        const { error: orderUpdateError } = await db
          .from('orders')
          .update({ status: 'past_due' })
          .eq('payment_environment', environment)
          .eq('solidgate_subscription_id', subscriptionId);
        if (orderUpdateError) {
          throw new Error(`subscription dunning update failed: ${orderUpdateError.message}`);
        }
      }

      await enqueueAnalytics(db, {
        eventKey: `subscription:${subscriptionId}:payment-failed:${invoiceId ?? callbackType}`,
        eventName: 'subscription_payment_failed',
        distinctId: row.session_id ?? userId ?? subscriptionId,
        properties: {
          ...commonAnalytics,
          billing_type: 'subscription_renewal',
          callback_type: callbackType,
          invoice_status: invoice?.status ?? null,
        },
      });

      if (lifecycleAlreadyApplied) return;
      if (!userId) return;
      const lifecycleApplied = await applySolidgateSubscriptionLifecycle(db, {
        row,
        userId,
        accessLevel: isRecurringAddon(productSlug) ? 'full' : 'grace',
        expiresAt: isRecurringAddon(productSlug)
          ? null
          : new Date(Date.now() + GRACE_PERIOD_MS).toISOString(),
        subscriptionId,
        source: 'solidgate_redemption',
        status: 'past_due',
        environment,
      });
      if (!lifecycleApplied) return;
      return;
    }

    // The end: retries exhausted, the buyer cancelled, or the term expired.
    case 'cancel':
    case 'expire': {
      if (!lifecycleAlreadyApplied) {
        const { error: orderUpdateError } = await db
          .from('orders')
          .update({ status: 'canceled' })
          .eq('payment_environment', environment)
          .eq('solidgate_subscription_id', subscriptionId);
        if (orderUpdateError) {
          throw new Error(`subscription cancellation update failed: ${orderUpdateError.message}`);
        }
        await revokeBySubscription(db, subscriptionId, environment);
      }
      // Hard cancel = immediate lock-out (Solidgate UAT item 8). Runs on
      // duplicate deliveries too — signing out an already signed-out user is
      // a no-op, and a retry may be the first delivery that reaches it.
      if (userId) await endSessionsWithoutAppAccess(db, userId, environment);
      await enqueueAnalytics(db, {
        eventKey: `subscription:${subscriptionId}:cancelled`,
        eventName: 'subscription_cancelled',
        distinctId: row.session_id ?? userId ?? subscriptionId,
        properties: {
          ...commonAnalytics,
          billing_type: 'subscription_lifecycle',
          callback_type: callbackType,
          cancel_code: sub?.cancel_code ?? null,
          cancel_message: sub?.cancel_message ?? null,
        },
      });
      return;
    }

    // Access continues until the paid period ends — record intent, do not
    // revoke before Solidgate emits the terminal cancel/expire callback.
    case 'scheduled_for_cancellation':
      return;

    case 'pause':
    case 'pause_schedule.create':
    case 'pause_schedule.update':
    case 'pause_schedule.delete':
    case 'switch_product':
    case 'create':
    case 'payment_attempt':
    case 'order_update':
      console.log('[solidgate-webhooks] noted', { callbackType, subscriptionId });
      return;

    default:
      throw new Error(`unsupported subscription callback_type: ${callbackType}`);
  }
}

// ── card_gate.chargeback.received ───────────────────────────────────────────

async function handleChargeback(
  db: SupabaseClient,
  event: ChargebackEvent,
  context?: WebhookContext,
): Promise<void> {
  const orderId = event.order?.order_id;
  if (!orderId) return;
  const environment = paymentEnvironment(context);
  const chargebackId = event.chargeback?.id !== undefined ? String(event.chargeback.id) : null;
  const chargebackStatus = event.chargeback?.status ?? 'in_progress';
  const chargebackAmount = Math.max(0, event.chargeback?.amount ?? event.order?.amount ?? 0);
  const reversed = CHARGEBACK_REVERSED_STATUSES.has(chargebackStatus);

  const { data: row, error: orderLookupError } = await db
    .from('orders')
    .select(INITIAL_ORDER_BINDING_COLUMNS)
    .eq('payment_environment', environment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  if (orderLookupError) throw new Error(`chargeback order lookup failed: ${orderLookupError.message}`);
  if (row && isOurProduct(row.product_slug)) {
    let sourceRow = row as InitialOrderBindingRow;
    let committedRow: InitialOrderBindingRow | null = null;
    let gross = 0;
    let refunded = 0;
    let net = 0;

    // Preserve the actual pre-dispute status. A browser finalizer may change
    // pending -> trialing between SELECT and UPDATE, so use a status CAS and
    // retry from the durable winner instead of writing a stale restore point.
    for (let attempt = 0; attempt < 3; attempt++) {
      gross = sourceRow.solidgate_original_amount_cents
        ?? sourceRow.amount_cents
        ?? event.order?.amount
        ?? 0;
      refunded = sourceRow.solidgate_refunded_amount_cents ?? 0;
      net = reversed
        ? Math.max(0, gross - refunded)
        : Math.max(0, gross - Math.max(refunded, chargebackAmount));
      const restoredStatus = sourceRow.solidgate_pre_dispute_status
        ?? (sourceRow.solidgate_subscription_id ? 'active' : 'completed');
      const { data: updated, error: orderUpdateError } = await db.from('orders').update({
        status: reversed ? restoredStatus : 'disputed',
        amount_cents: net,
        solidgate_original_amount_cents: gross,
        solidgate_chargeback_id: chargebackId,
        solidgate_chargeback_status: chargebackStatus,
        solidgate_chargeback_amount_cents: chargebackAmount,
        ...(
          !reversed
          && sourceRow.status !== 'disputed'
          && { solidgate_pre_dispute_status: sourceRow.status }
        ),
      })
        .eq('payment_environment', environment)
        .eq('id', sourceRow.id)
        .eq('solidgate_order_id', orderId)
        .eq('status', sourceRow.status)
        .select(INITIAL_ORDER_BINDING_COLUMNS)
        .maybeSingle();
      if (orderUpdateError) {
        throw new Error(`chargeback order update failed: ${orderUpdateError.message}`);
      }
      if (updated) {
        committedRow = updated as InitialOrderBindingRow;
        break;
      }

      const { data: winner, error: winnerError } = await db.from('orders')
        .select(INITIAL_ORDER_BINDING_COLUMNS)
        .eq('payment_environment', environment)
        .eq('id', sourceRow.id)
        .eq('solidgate_order_id', orderId)
        .maybeSingle();
      if (winnerError) {
        throw new Error(`chargeback order winner read failed: ${winnerError.message}`);
      }
      if (!winner || !isOurProduct(winner.product_slug)) {
        throw new Error('chargeback order CAS lost and the exact order disappeared');
      }
      sourceRow = winner as InitialOrderBindingRow;
    }
    if (!committedRow) throw new Error('chargeback order CAS exhausted without a durable update');
    const trustedMetadata = stringMetadata(committedRow.tracking_metadata);

    // Access goes immediately while funds are disputed. A reversal restores
    // revenue but not access automatically: the subscription may meanwhile
    // have legitimately expired/cancelled in its own ordered event stream.
    if (!reversed) {
      await revokeInitialOrderEntitlement(db, {
        environment,
        orderId: committedRow.id,
        reason: 'chargeback',
      });
    }

    await enqueueAnalytics(db, {
      eventKey: `chargeback:${chargebackId ?? orderId}:${chargebackStatus}`,
      eventName: reversed ? 'chargeback_reversed' : 'chargeback_received',
      distinctId: committedRow.session_id ?? committedRow.user_id ?? orderId,
      properties: {
        provider: 'solidgate',
        environment: context?.environment ?? runtime.environment,
        billing_type: committedRow.solidgate_subscription_id ? 'subscription_initial' : 'one_time',
        product_slug: committedRow.product_slug,
        product: slugFromCode(committedRow.product_slug) ?? committedRow.product_slug,
        product_code: committedRow.product_slug,
        product_id: committedRow.product_slug,
        product_name: canonicalProductName(committedRow.product_slug, trustedMetadata.product_name),
        price_id: trustedMetadata.price_id ?? null,
        solidgate_price_id: trustedMetadata.price_id ?? null,
        solidgate_order_id: orderId,
        order_id: orderId,
        transaction_id: orderId,
        solidgate_subscription_id: committedRow.solidgate_subscription_id,
        chargeback_id: chargebackId,
        chargeback_status: chargebackStatus,
        chargeback_amount_cents: chargebackAmount,
        currency: (
          event.chargeback?.currency
          ?? event.order?.currency
          ?? committedRow.currency
          ?? ''
        ).toUpperCase(),
        reason_code: event.chargeback?.reason_code,
        reason: event.chargeback?.reason_description,
      },
    });

    await sendDisputeAlert(
      `⚠️ Solidgate chargeback ${event.chargeback?.type ?? ''} (${chargebackStatus})\norder: ${orderId}\namount: ${chargebackAmount} ${event.chargeback?.currency ?? committedRow.currency}\nreason: ${event.chargeback?.reason_description ?? 'n/a'}`,
    );
    return;
  }

  // Solidgate-generated renewal order ids do not exist in `orders`; resolve
  // them through the invoice-order map populated by subscription.updated.v2.
  const { data: mapping, error: mappingError } = await db.from('solidgate_invoice_orders')
    .select('solidgate_invoice_id,solidgate_subscription_id,amount_cents,currency,refunded_amount_cents,product_price_id,order_metadata')
    .eq('environment', environment)
    .eq('solidgate_order_id', orderId)
    .maybeSingle();
  if (mappingError) throw new Error(`chargeback renewal mapping lookup failed: ${mappingError.message}`);
  if (!mapping) return;
  const analyticsContext = await renewalAnalyticsContext(
    db,
    event,
    mapping as RenewalOrderMapping,
    environment,
  );
  const { data: renewal, error: renewalError } = await db.from('renewal_events')
    .select('gross_amount_cents,amount_cents,refunded_amount_cents')
    .eq('payment_environment', environment)
    .eq('solidgate_invoice_id', mapping.solidgate_invoice_id)
    .maybeSingle();
  if (renewalError) throw new Error(`chargeback renewal lookup failed: ${renewalError.message}`);
  const gross = renewal?.gross_amount_cents ?? mapping.amount_cents ?? renewal?.amount_cents ?? 0;
  const refunded = renewal?.refunded_amount_cents ?? mapping.refunded_amount_cents ?? 0;
  const net = reversed
    ? Math.max(0, gross - refunded)
    : Math.max(0, gross - Math.max(refunded, chargebackAmount));
  const { error: mappingUpdateError } = await db.from('solidgate_invoice_orders').update({
    chargeback_id: chargebackId,
    chargeback_status: chargebackStatus,
    chargeback_amount_cents: chargebackAmount,
    event_created_at: context?.eventCreatedAt ?? null,
    updated_at: new Date().toISOString(),
  }).eq('environment', environment).eq('solidgate_order_id', orderId);
  if (mappingUpdateError) {
    throw new Error(`chargeback renewal mapping update failed: ${mappingUpdateError.message}`);
  }
  if (renewal) {
    const { error: renewalUpdateError } = await db.from('renewal_events').update({
      amount_cents: net,
      status: reversed ? 'chargeback_reversed' : 'disputed',
      chargeback_id: chargebackId,
      chargeback_status: chargebackStatus,
      chargeback_amount_cents: chargebackAmount,
      event_created_at: context?.eventCreatedAt ?? null,
    }).eq('payment_environment', environment)
      .eq('solidgate_invoice_id', mapping.solidgate_invoice_id);
    if (renewalUpdateError) {
      throw new Error(`chargeback renewal update failed: ${renewalUpdateError.message}`);
    }
  }
  if (!reversed) await revokeBySubscription(db, mapping.solidgate_subscription_id, environment);
  await enqueueAnalytics(db, {
    eventKey: `chargeback:${chargebackId ?? orderId}:${chargebackStatus}`,
    eventName: reversed ? 'chargeback_reversed' : 'chargeback_received',
    distinctId: mapping.solidgate_subscription_id,
    properties: {
      ...analyticsContext,
      environment: context?.environment ?? runtime.environment,
      billing_type: 'subscription_renewal',
      solidgate_order_id: orderId,
      order_id: orderId,
      transaction_id: orderId,
      solidgate_invoice_id: mapping.solidgate_invoice_id,
      solidgate_subscription_id: mapping.solidgate_subscription_id,
      chargeback_id: chargebackId,
      chargeback_status: chargebackStatus,
      chargeback_amount_cents: chargebackAmount,
      currency: (event.chargeback?.currency ?? mapping.currency ?? '').toUpperCase(),
      reason_code: event.chargeback?.reason_code,
      reason: event.chargeback?.reason_description,
    },
  });

  await sendDisputeAlert(
    `⚠️ Solidgate renewal chargeback ${event.chargeback?.type ?? ''} (${chargebackStatus})\norder: ${orderId}\namount: ${chargebackAmount} ${event.chargeback?.currency ?? mapping.currency}\nreason: ${event.chargeback?.reason_description ?? 'n/a'}`,
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

function requireFinancialEntityId(
  eventType: string,
  entityPath: string,
  value: unknown,
): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value !== value.trim()
  ) {
    throw new Error(`${eventType} requires a non-empty string at ${entityPath}`);
  }
  return value;
}

export async function handleEvent(
  db: SupabaseClient,
  eventType: string,
  payload: unknown,
  context?: WebhookContext,
): Promise<void> {
  switch (eventType) {
    case 'card_gate.order.updated':
    case 'alt_gate.order.updated': {
      const orderId = requireFinancialEntityId(
        eventType,
        'order.order_id',
        (payload as CardOrderEvent | null)?.order?.order_id,
      );
      await withEntityOrdering(db, context, 'payment', orderId, () =>
        handleOrderUpdated(db, payload as CardOrderEvent, context));
      return;
    }
    case 'subscription.updated.v2': {
      const subscriptionId = requireFinancialEntityId(
        eventType,
        'subscription.id',
        (payload as SubscriptionEvent | null)?.subscription?.id,
      );
      await withEntityOrdering(db, context, 'subscription', subscriptionId, () =>
        handleSubscription(db, payload as SubscriptionEvent, context));
      return;
    }
    case 'card_gate.chargeback.received': {
      const orderId = requireFinancialEntityId(
        eventType,
        'order.order_id',
        (payload as ChargebackEvent | null)?.order?.order_id,
      );
      await withEntityOrdering(db, context, 'payment', orderId, () =>
        handleChargeback(db, payload as ChargebackEvent, context));
      return;
    }
    case 'subscription.updated':
      throw new Error(
        'legacy Solidgate subscription.updated is unsupported; configure subscription.updated.v2',
      );
    default:
      throw new Error(`unsupported Solidgate webhook event type: ${eventType}`);
  }
}

export async function serveRequest(
  req: Request,
  dbOverride?: SupabaseClient,
): Promise<Response> {
  // The signature covers the RAW bytes: never JSON.parse before verifying.
  const rawBody = await req.text();
  const signature = req.headers.get('signature') ?? '';
  const merchant = req.headers.get('merchant') ?? '';
  const eventId = req.headers.get('solidgate-event-id') ?? '';
  const eventType = req.headers.get('solidgate-event-type') ?? '';
  const eventCreatedAt = req.headers.get('solidgate-event-created-at');

  const valid = await verifySolidgateWebhook({
    publicKey: runtime.webhookPublicKey,
    secretKey: runtime.webhookSecretKey,
    rawBody,
    signature,
  });
  if (!valid) {
    console.error('[solidgate-webhooks] bad signature', { merchant, eventType });
    return new Response('invalid signature', {
      status: 400,
      headers: { [WEBHOOK_CONTRACT_HEADER]: WEBHOOK_CONTRACT_VERSION },
    });
  }

  if (!eventId) return new Response('missing event id', { status: 400 });
  if (!eventType) return new Response('missing event type', { status: 400 });
  const parsedCreatedAt = eventCreatedAt ? new Date(eventCreatedAt) : null;
  if (!parsedCreatedAt || Number.isNaN(parsedCreatedAt.getTime())) {
    return new Response('missing or invalid event created at', { status: 400 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const db = dbOverride ?? admin();
  let businessCompleted = false;
  let inboxClaim: WebhookClaim | null = null;
  try {
    const createdAtIso = parsedCreatedAt.toISOString();
    const claim = await claimEvent(
      db,
      eventId,
      eventType,
      createdAtIso,
      runtime.environment,
      payload,
    );
    if (claim.state === 'completed') {
      businessCompleted = true;
      scheduleFunnelFulfillment();
      await drainAnalyticsOutbox(db);
      return Response.json({ duplicate: true });
    }
    if (claim.state === 'busy') {
      return Response.json(
        { retry: true, reason: 'event is already processing' },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
    inboxClaim = claim;

    await handleEvent(db, eventType, payload, {
      eventId,
      eventCreatedAt: createdAtIso,
      environment: runtime.environment,
    });
    await completeEvent(db, eventId, runtime.environment, claim);
    businessCompleted = true;
    scheduleFunnelFulfillment();
    await drainAnalyticsOutbox(db);
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Analytics delivery deliberately returns 5xx so Solidgate redelivers and
    // drains the durable outbox. Keep an already-completed business event
    // completed: the retry takes the duplicate path without repeating CRM,
    // provisioning or dispute-alert side effects.
    let responseMessage = message;
    if (!businessCompleted && inboxClaim) {
      try {
        await failEvent(db, eventId, runtime.environment, inboxClaim, message);
      } catch (failErr) {
        const failMessage = failErr instanceof Error ? failErr.message : String(failErr);
        responseMessage = `${message}; ${failMessage}`;
        console.error('[solidgate-webhooks] inbox failure persist failed:', failMessage, {
          eventType,
          eventId,
        });
      }
    }
    console.error('[solidgate-webhooks] handler failed:', message, { eventType, eventId });
    return new Response(responseMessage, { status: 500 });
  } finally {
    // If an exception happened between PostHog construction and the normal
    // outbox shutdown, never leave a singleton queued across invocations.
    try {
      await shutdownPostHog();
    } catch (err) {
      console.error('[solidgate-webhooks] PostHog shutdown failed:', err instanceof Error ? err.message : err);
      _posthog = null;
    }
  }
}

// Only the live module entrypoint serves directly. The sandbox wrapper imports
// this module, configures isolated keys/side effects, then starts its own serve.
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  Deno.serve((req) => serveRequest(req));
}
