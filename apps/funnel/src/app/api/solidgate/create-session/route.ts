import { NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { PRICE_MAP, LOCALE_CURRENCY_MAP, resolveProductPrice, type Locale, type ProductId } from '@repo/shared/price-map';
import {
  buildFormMerchantData,
  buildSolidgateOrderId,
  getSolidgateKeys,
  introOfferEmailHash,
  parseSolidgateOrderId,
  paymentEnvironmentForVercel,
  type IntroOfferClaimResult,
} from '@repo/shared/solidgate';
import { PRODUCT_ID_TO_CODE, SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { solidgateDynamicDescriptor } from '@repo/shared/solidgate/descriptor';
import { solidgateOrderDescription } from '@repo/shared/locale-prefixes';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';
import { localePathSegment } from '@repo/i18n/routing';
import catalogIds from '@repo/shared/solidgate/catalog-ids.json';
import { paymentReturnOrigin } from '@/lib/payment/funnel-origins';
import {
  UTM_KEYS,
  sanitizeAttributionSnapshot,
  selectFirstTouchUtm,
} from '@/features/analytics/lib/attribution';
import {
  FUNNEL_CODE,
  checkoutProductContext,
} from '@/features/analytics/lib/checkout-context';

/**
 * Solidgate checkout session for the hosted payment form.
 *
 * There is no API round-trip to open a payment: the intent is a
 * JSON blob we AES-encrypt with the channel secret and hand to the hosted form.
 * Everything money-related is therefore decided HERE, server-side:
 *
 *   - the tier the client names is validated against the catalog; the amount and
 *     currency are looked up from the session's locale, never from the request;
 *   - the order row is written BEFORE the intent is handed out, so an order can
 *     never exist without a session to bind it to (fail-closed);
 *   - order_id is server-generated and travels inside the encrypted intent, so
 *     it doubles as the idempotency key and the session binding (Solidgate has
 *     no idempotency-key mechanism).
 */

export const dynamic = 'force-dynamic';

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tiers sold at checkout. trial_monthly is the rebill price, never sold directly. */
const CHECKOUT_TIERS = new Set<ProductId>([
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
  'special_free',
]);

type CatalogIds = Record<string, { product_id: string; prices: Record<string, string> }>;

type RpcError = { code?: string; message: string };

type MerchantData = {
  merchant: string;
  paymentIntent: string;
  signature: string;
};

type MainCheckoutReservation = {
  order_db_id: string;
  solidgate_order_id: string;
  bound_session_id: string;
  bound_payment_environment: 'production' | 'sandbox';
  bound_product_slug: string;
  bound_product_name: string;
  bound_offer_slug: string;
  bound_amount_cents: number;
  bound_currency: string;
  bound_order_status: string;
  bound_payment_status: string | null;
  bound_tracking_metadata: Record<string, unknown>;
  bound_customer_email: string;
  bound_checkout_locale: string;
  bound_solidgate_product_id: string;
  bound_solidgate_payment_action: 'auth_settle' | 'auth_0_amount';
  is_new: boolean;
  should_build: boolean;
  merchant_data: MerchantData | null;
};

type CheckoutRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: RpcError | null }>;

const TERMINAL_PROVIDER_STATUSES = new Set(['auth_failed', 'declined', 'void_ok']);
const CHECKOUT_BUILD_POLL_ATTEMPTS = 40;
const CHECKOUT_BUILD_POLL_MS = 25;

function checkoutRpc(supabase: ReturnType<typeof getSupabaseAdminClient>): CheckoutRpc {
  // The migration intentionally lands independently from generated database
  // types. Keep the temporary adapter narrow until those types are regenerated.
  return supabase.rpc.bind(supabase) as unknown as CheckoutRpc;
}

function isMerchantData(value: unknown): value is MerchantData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.merchant === 'string' && candidate.merchant.length > 0 &&
    typeof candidate.paymentIntent === 'string' && candidate.paymentIntent.length > 0 &&
    typeof candidate.signature === 'string' && candidate.signature.length > 0
  );
}

function asSingleReservation(data: unknown): MainCheckoutReservation | null {
  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return null;
  return rows[0] as MainCheckoutReservation;
}

function reservationMismatch(
  reservation: MainCheckoutReservation,
  expected: {
    paymentEnvironment: 'production' | 'sandbox';
    sessionId: string;
    tier: ProductId;
    productCode: string;
    amountCents: number;
    currency: string;
    productPriceId: string;
    funnelVariant: string;
    customerEmail: string;
    checkoutLocale: Locale;
    solidgateProductId: string;
    paymentAction: 'auth_settle' | 'auth_0_amount';
  },
): string | null {
  const parsedOrderId = typeof reservation.solidgate_order_id === 'string'
    ? parseSolidgateOrderId(reservation.solidgate_order_id)
    : null;
  const canonicalOrderId = parsedOrderId
    ? buildSolidgateOrderId(expected.sessionId, expected.tier, parsedOrderId.attempt)
    : null;
  const metadata = reservation.bound_tracking_metadata;

  if (
    typeof reservation.order_db_id !== 'string' ||
    !SESSION_UUID_PATTERN.test(reservation.order_db_id) ||
    !parsedOrderId ||
    !Number.isSafeInteger(parsedOrderId.attempt) ||
    parsedOrderId.attempt > 999999999 ||
    parsedOrderId.sessionId !== expected.sessionId ||
    parsedOrderId.offeringSlug !== expected.tier ||
    canonicalOrderId !== reservation.solidgate_order_id
  ) return 'order_id';
  if (reservation.bound_payment_environment !== expected.paymentEnvironment) return 'environment';
  if (reservation.bound_session_id !== expected.sessionId) return 'session';
  if (
    reservation.bound_product_slug !== expected.productCode ||
    reservation.bound_product_name !== expected.productCode ||
    reservation.bound_offer_slug !== expected.tier
  ) return 'product';
  if (reservation.bound_amount_cents !== expected.amountCents) return 'amount';
  if (reservation.bound_currency !== expected.currency.toLowerCase()) return 'currency';
  if (reservation.bound_customer_email !== expected.customerEmail) return 'customer_email';
  if (reservation.bound_checkout_locale !== expected.checkoutLocale) return 'checkout_locale';
  if (reservation.bound_solidgate_product_id !== expected.solidgateProductId) return 'provider_product';
  if (reservation.bound_solidgate_payment_action !== expected.paymentAction) return 'payment_action';
  if (reservation.bound_order_status !== 'pending') return 'status';
  if (
    reservation.bound_payment_status !== null &&
    TERMINAL_PROVIDER_STATUSES.has(reservation.bound_payment_status)
  ) return 'payment_status';
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'metadata';
  const metadataValues = Object.values(metadata);
  if (
    Object.keys(metadata).length > 10 ||
    metadataValues.some((value) => typeof value !== 'string' || value.length > 380)
  ) return 'metadata';
  if (
    metadata.session_id !== expected.sessionId ||
    metadata.product_slug !== expected.tier ||
    metadata.price_id !== expected.productPriceId ||
    metadata.funnel_code !== FUNNEL_CODE ||
    metadata.funnel_variant !== expected.funnelVariant
  ) return 'metadata';
  if (typeof reservation.is_new !== 'boolean' || typeof reservation.should_build !== 'boolean') {
    return 'rpc_shape';
  }
  if (reservation.merchant_data !== null && !isMerchantData(reservation.merchant_data)) {
    return 'merchant_data';
  }
  if (reservation.merchant_data !== null && reservation.should_build) return 'builder_state';
  return null;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isPrivateOrLoopbackIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (!normalized) return true;
  const version = isIP(normalized);
  if (version === 0) return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  if (version === 6) return false;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function resolveClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (process.env.VERCEL_ENV === 'production') {
    return forwarded && !isPrivateOrLoopbackIp(forwarded) ? forwarded : null;
  }
  return forwarded || '::1';
}

/**
 * Indexed auth-user lookup via the find_auth_user_id_by_email RPC (migration
 * 20260716191000). The old listUsers pagination walked the WHOLE directory on
 * every trial checkout open — seconds of latency at scale, and its failure
 * mode (503, fail-closed) blocked checkout outright.
 */
async function findAuthUserIdByEmail(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  email: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('find_auth_user_id_by_email', {
    p_email: email,
  });
  if (error) throw new Error(`auth lookup failed: ${error.message}`);
  return (data as string | null) ?? null;
}

export async function POST(request: Request) {
  try {
    const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
    const body = (await request.json()) as {
      productId?: unknown;
      sessionId?: unknown;
      utm?: Record<string, string>;
      attribution?: unknown;
    };
    const { productId, sessionId } = body;

    if (typeof productId !== 'string' || !(productId in PRICE_MAP) || !CHECKOUT_TIERS.has(productId as ProductId)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 });
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }
    if (!SESSION_UUID_PATTERN.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId format' }, { status: 400 });
    }
    const tier = productId as ProductId;
    const productCode = PRODUCT_ID_TO_CODE[tier];

    const supabase = getSupabaseAdminClient();
    const rpc = checkoutRpc(supabase);
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('locale, email, user_id')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionError) {
      return NextResponse.json({ error: `Session lookup failed: ${sessionError.message}` }, { status: 500 });
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const { data: identityRows, error: identityError } = await rpc(
      'get_solidgate_main_checkout_identity',
      {
        p_payment_environment: paymentEnvironment,
        p_session_id: sessionId,
        p_product_slug: productCode,
      },
    );
    if (identityError) {
      console.error('[solidgate/create-session] checkout identity lookup failed:', identityError.message);
      return NextResponse.json({ error: 'Unable to verify checkout identity' }, { status: 503 });
    }
    const identities = Array.isArray(identityRows) ? identityRows : [];
    if (identities.length > 1) {
      return NextResponse.json({ error: 'Ambiguous checkout identity' }, { status: 500 });
    }
    const existingIdentity = identities[0] as {
      order_db_id?: unknown;
      offer_slug?: unknown;
      customer_email?: unknown;
      checkout_locale?: unknown;
      solidgate_product_id?: unknown;
      solidgate_payment_action?: unknown;
      amount_cents?: unknown;
      currency?: unknown;
      tracking_metadata?: unknown;
      user_id?: unknown;
    } | undefined;
    if (existingIdentity && existingIdentity.offer_slug !== tier) {
      return NextResponse.json(
        { error: 'An existing checkout is bound to another offer' },
        { status: 409 },
      );
    }

    // Exact retries use the immutable order snapshot. A mutable session edit
    // during hosted checkout/3DS must not change the provider customer or the
    // price locale. Only a brand-new checkout reads current session profile.
    const sessionEmail = typeof existingIdentity?.customer_email === 'string'
      ? existingIdentity.customer_email
      : typeof session.email === 'string'
        ? session.email.trim().toLowerCase()
        : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sessionEmail) || sessionEmail.length > 320) {
      return NextResponse.json(
        { error: 'Email required before payment', code: 'EMAIL_REQUIRED' },
        { status: 400 },
      );
    }

    // Locale (hence currency) is server-authoritative: it comes from the
    // persisted session, never the request body. A locale with content but no
    // verified pricing silently falls back to en/USD rather than charging wrong.
    const enabledLocales = (process.env.ENABLED_CHECKOUT_LOCALES ?? 'en')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const sessionLocale = (existingIdentity?.checkout_locale ?? session.locale) as string | null;
    if (!sessionLocale || !(sessionLocale in LOCALE_CURRENCY_MAP)) {
      return NextResponse.json({ error: 'Session locale missing' }, { status: 500 });
    }
    if (!existingIdentity && !enabledLocales.includes(sessionLocale)) {
      return NextResponse.json({ error: 'Checkout is unavailable for this locale', code: 'checkout_locale_disabled' }, { status: 409 });
    }
    // Locale controls currency; never silently substitute a different quote.
    const effectiveLocale = sessionLocale as Locale;

    const ip = resolveClientIp(request);
    if (!ip) {
      return NextResponse.json({ error: 'Unable to determine a public customer IP' }, { status: 400 });
    }

    // Every checkout tier is a 7-day introductory subscription product, even
    // when its intro amount is non-zero. Treating only trial1/special_free as a
    // "trial" lets the same account open parallel subscriptions by selecting a
    // different paid tier because each funnel session has a new Solidgate
    // customer_account_id. Resolve the account by indexed email and enforce the
    // one-intro-offer policy consistently across all six tiers.
    //
    // Fail closed when identity/entitlement state cannot be verified: issuing
    // an encrypted intent here is the point after which money can move.
    if (CHECKOUT_TIERS.has(tier) && sessionEmail) {
      try {
        const existingUserId = await findAuthUserIdByEmail(supabase, sessionEmail);
        if (existingUserId) {
          const { data: prior, error: priorError } = await supabase
            .from('entitlements')
            .select('id')
            .eq('payment_environment', paymentEnvironment)
            .eq('user_id', existingUserId)
            // Exact current main-plan code plus the two tier slug families.
            // Deliberately NOT a broad `%<PREFIX>%SUB` match: that also catches
            // the add-on and lifetime offering codes and would incorrectly burn
            // the main-plan introductory offer.
            .or(
              `product_slug.eq.${SOLIDGATE_PRODUCT_CODES.main},product_slug.ilike.trial%,product_slug.ilike.special%`,
            )
            .limit(1);
          if (priorError) throw new Error(`entitlement lookup failed: ${priorError.message}`);
          if (prior && prior.length > 0) {
            return NextResponse.json(
              {
                error: 'You have already used an introductory subscription offer.',
                code: 'INTRO_OFFER_ALREADY_USED',
              },
              { status: 409 },
            );
          }
        }
      } catch (err) {
        console.error('[solidgate/create-session] abuse-guard unavailable:', err);
        return NextResponse.json(
          { error: 'Unable to verify trial eligibility' },
          { status: 503 },
        );
      }
    }

    const currentPrice = resolveProductPrice(tier, effectiveLocale);
    const currentCurrency = LOCALE_CURRENCY_MAP[effectiveLocale];
    const boundTrackingMetadata = existingIdentity?.tracking_metadata;
    if (
      existingIdentity &&
      (
        !Number.isSafeInteger(existingIdentity.amount_cents) ||
        (existingIdentity.amount_cents as number) < 0 ||
        typeof existingIdentity.currency !== 'string' ||
        existingIdentity.currency !== existingIdentity.currency.toLowerCase() ||
        typeof existingIdentity.solidgate_product_id !== 'string' ||
        !existingIdentity.solidgate_product_id ||
        (existingIdentity.solidgate_payment_action !== 'auth_settle' &&
          existingIdentity.solidgate_payment_action !== 'auth_0_amount') ||
        !boundTrackingMetadata ||
        typeof boundTrackingMetadata !== 'object' ||
        Array.isArray(boundTrackingMetadata)
      )
    ) {
      return NextResponse.json({ error: 'Invalid bound checkout pricing' }, { status: 500 });
    }
    const amountCents = existingIdentity
      ? existingIdentity.amount_cents as number
      : currentPrice.amountCents;
    const currency = existingIdentity
      ? existingIdentity.currency as string
      : currentCurrency;
    const catalog = catalogIds as CatalogIds;
    const entry = catalog[tier];
    const boundPriceId = existingIdentity
      ? (boundTrackingMetadata as Record<string, unknown>).price_id
      : undefined;
    const productPriceId = existingIdentity
      ? typeof boundPriceId === 'string' && boundPriceId.trim()
        ? boundPriceId
        : undefined
      : entry?.prices?.[currency];
    if (!entry?.product_id || !productPriceId) {
      // The catalog is committed, so this only fires if the channel was never
      // seeded (scripts/solidgate-seed-catalog.ts --apply).
      return NextResponse.json({ error: 'Solidgate catalog not seeded for this tier/currency' }, { status: 500 });
    }
    const currentProductContext = checkoutProductContext(tier, effectiveLocale);
    if (!currentProductContext) {
      return NextResponse.json({ error: 'Missing checkout tracking catalog data' }, { status: 500 });
    }
    const productContext = {
      ...currentProductContext,
      price_id: productPriceId,
      solidgate_price_id: productPriceId,
      amount_cents: amountCents,
      currency: currency.toUpperCase(),
      ...(existingIdentity &&
      typeof (boundTrackingMetadata as Record<string, unknown>).funnel_variant === 'string'
        ? {
            funnel_variant: (boundTrackingMetadata as Record<string, unknown>)
              .funnel_variant as typeof currentProductContext.funnel_variant,
          }
        : {}),
    };
    const solidgateProductId = existingIdentity
      ? existingIdentity.solidgate_product_id as string
      : entry.product_id;
    const paymentAction = existingIdentity
      ? existingIdentity.solidgate_payment_action as 'auth_settle' | 'auth_0_amount'
      : amountCents === 0
        ? 'auth_0_amount'
        : 'auth_settle';

    // Atomically reserve the one introductory main-plan offer before handing
    // out a payable intent. The auth/entitlement lookup above covers history;
    // this claim closes the pre-webhook race between two fresh sessions or two
    // different tier products (which have distinct Solidgate product IDs).
    const introEmailHash = await introOfferEmailHash(sessionEmail);
    const { data: introClaim, error: introClaimError } = await supabase.rpc(
      'claim_solidgate_intro_offer',
      {
        p_payment_environment: paymentEnvironment,
        p_email_hash: introEmailHash,
        p_session_id: sessionId,
        p_tier: tier,
      },
    );
    if (introClaimError) {
      console.error('[solidgate/create-session] intro claim unavailable:', introClaimError.message);
      return NextResponse.json(
        { error: 'Unable to reserve introductory offer' },
        { status: 503 },
      );
    }
    const claimResult = introClaim as IntroOfferClaimResult;
    if (claimResult === 'already_used') {
      return NextResponse.json(
        {
          error: 'You have already used an introductory subscription offer.',
          code: 'INTRO_OFFER_ALREADY_USED',
        },
        { status: 409 },
      );
    }
    if (claimResult === 'in_progress') {
      console.warn('[solidgate/create-session] intro offer already reserved', {
        paymentEnvironment,
        sessionId,
        tier,
      });
      return NextResponse.json(
        {
          error: 'An introductory subscription checkout is already in progress.',
          code: 'INTRO_OFFER_IN_PROGRESS',
        },
        { status: 409 },
      );
    }
    if (claimResult !== 'claimed' && claimResult !== 'retry') {
      console.error('[solidgate/create-session] unexpected intro claim result:', introClaim);
      return NextResponse.json(
        { error: 'Unable to reserve introductory offer' },
        { status: 503 },
      );
    }

    const attribution = sanitizeAttributionSnapshot(body.attribution);
    const attributedUtm = selectFirstTouchUtm(attribution);
    const utm: Record<string, string> = {};
    for (const key of UTM_KEYS) {
      const value = body.utm?.[key] ?? attributedUtm[key];
      if (typeof value === 'string' && value.trim()) utm[key] = value.trim().slice(0, 380);
    }
    // Exactly the same sanitized payload is written to our ledger and encrypted
    // into Solidgate. The local copy lets account promotion inherit attribution
    // before an unordered provider webhook arrives.
    const orderMetadata = existingIdentity
      ? boundTrackingMetadata as Record<string, unknown>
      : {
          funnel_code: FUNNEL_CODE,
          funnel_variant: productContext.funnel_variant,
          session_id: sessionId,
          product_slug: tier,
          // Solidgate caps metadata at 10 keys. Locale remains available from
          // sessions + the native `language` field; the PSP price UUID cannot be
          // reconstructed reliably from a card-order callback, so it owns this
          // slot for the canonical server-side purchase event.
          price_id: productPriceId,
          ...utm,
        };

    // Must be same-origin with the page the buyer is on: success_url loads in
    // the form's iframe and CSP frame-src only allows 'self' (previews and
    // www vs apex would otherwise block it after a SUCCESSFUL charge).
    const origin = paymentReturnOrigin(request);
    const trafficSource =
      attribution?.last_touch.utm_source ?? attribution?.first_touch.utm_source ?? utm.utm_source ?? 'direct';

    // The database owns both attempt allocation and the open-vs-retry decision.
    // Its transaction-scoped Postgres advisory lock is keyed by environment + session +
    // canonical main product, so all six UI tiers serialize onto the same main
    // subscription. A pending order is returned, never collision-bumped.
    const builderToken = randomUUID();
    const openArgs = {
      p_payment_environment: paymentEnvironment,
      p_session_id: sessionId,
      p_offer_slug: tier,
      p_product_slug: productCode,
      p_amount_cents: amountCents,
      p_currency: currency.toLowerCase(),
      p_product_name: productCode,
      p_tracking_metadata: orderMetadata,
      p_builder_token: builderToken,
      p_customer_email: sessionEmail,
      p_checkout_locale: effectiveLocale,
      p_solidgate_product_id: solidgateProductId,
      p_solidgate_payment_action: paymentAction,
      p_user_id: existingIdentity ? existingIdentity.user_id ?? null : session.user_id,
    };
    const expectedBinding = {
      paymentEnvironment,
      sessionId,
      tier,
      productCode,
      amountCents,
      currency,
      productPriceId,
      funnelVariant: productContext.funnel_variant,
      customerEmail: sessionEmail,
      checkoutLocale: effectiveLocale,
      solidgateProductId,
      paymentAction,
    };
    const loadReservation = async (): Promise<
      | { ok: true; reservation: MainCheckoutReservation }
      | { ok: false; status: number; message: string }
    > => {
      const { data, error } = await rpc('open_solidgate_main_checkout_v2', openArgs);
      if (error) return { ok: false, status: 503, message: error.message };
      const reservation = asSingleReservation(data);
      if (!reservation) return { ok: false, status: 500, message: 'unexpected RPC result' };
      const mismatch = reservationMismatch(reservation, expectedBinding);
      if (mismatch) return { ok: false, status: 500, message: `binding mismatch: ${mismatch}` };
      return { ok: true, reservation };
    };

    let loaded = await loadReservation();
    if (!loaded.ok) {
      console.error('[solidgate/create-session] atomic order open failed:', loaded.message);
      return NextResponse.json({ error: 'Unable to open checkout safely' }, { status: loaded.status });
    }
    let reservation = loaded.reservation;

    // If another request owns the short encryption build, wait for its durable
    // result instead of producing a second hosted-form session. This is bounded;
    // a later request can take over the SAME order after the database lease.
    for (
      let poll = 0;
      !reservation.merchant_data && !reservation.should_build && poll < CHECKOUT_BUILD_POLL_ATTEMPTS;
      poll++
    ) {
      await wait(CHECKOUT_BUILD_POLL_MS);
      loaded = await loadReservation();
      if (!loaded.ok) {
        console.error('[solidgate/create-session] checkout payload wait failed:', loaded.message);
        return NextResponse.json({ error: 'Unable to resume checkout safely' }, { status: loaded.status });
      }
      reservation = loaded.reservation;
    }

    const orderId = reservation.solidgate_order_id;
    if (reservation.merchant_data) {
      return NextResponse.json({
        merchantData: reservation.merchant_data,
        orderId,
        tracking: productContext,
      });
    }
    if (!reservation.should_build) {
      return NextResponse.json(
        { error: 'Checkout is still initializing', code: 'CHECKOUT_INITIALIZING' },
        { status: 503 },
      );
    }

    const keys = getSolidgateKeys();
    const boundOrderMetadata = reservation.bound_tracking_metadata as Record<string, string>;
    const merchantData = await buildFormMerchantData(keys.publicKey, keys.secretKey, {
      order_id: orderId,
      // Data-team grammar ({PREFIX}_{code}); locale also rides in metadata.
      order_description: solidgateOrderDescription(effectiveLocale, productCode),
      // Statement shows base descriptor + this suffix (e.g. APP/:*ACME).
      // undefined drops out at JSON.stringify time inside the encryptor.
      dynamic_descriptor: solidgateDynamicDescriptor(productCode),
      // The intro price is what the customer pays now; the product's own
      // product_price is what rebills after its trial period.
      amount: amountCents,
      currency: currency.toUpperCase(),
      apple_pay_merchant_name: BOILERPLATE_BRAND.name,
      // Subscription flow: the product supplies the billing period + trial, and
      // product_price_id pins the currency on a multi-currency product.
      product_id: reservation.bound_solidgate_product_id,
      product_price_id: productPriceId,
      // Session-scoped, matching the funnel's one-customer-per-session model
      // (the vault and the OTO chain are keyed the same way).
      customer_account_id: sessionId,
      customer_email: sessionEmail,
      // Production 3DS drill: issuers keep low-value payments frictionless, so
      // a real challenge is only reproducible on demand. A buyer email carrying
      // the +3ds marker (tester+3ds@gmail.com) forces the challenge flow for
      // that checkout only; undefined drops out of the intent for everyone else.
      force3ds: /\+3ds@/i.test(sessionEmail) || undefined,
      ip_address: ip,
      platform: 'WEB',
      language: effectiveLocale,
      // First-class Solidgate fields appear in Hub and can drive routing rules;
      // they do not consume the ten order_metadata slots.
      traffic_source: trafficSource.slice(0, 255),
      transaction_source: `funnel:${productContext.funnel_variant}`,
      website: new URL(origin).origin,
      // success_url is only used by redirect-style flows (an issuer that
      // full-page-redirects for 3DS); the inline card flow reports success via
      // the SDK event instead. It carries the order id so the landing page can
      // grant after a full-page 3DS return.
      //
      // It must return the buyer to the page that SOLD to them: the special
      // variants have no completed quiz, and /offer/details (variant "main")
      // would bounce them to /offer before the sg_order grant could resume the
      // OTO chain.
      success_url: `${origin}${localePathSegment(effectiveLocale)}${
        productContext.funnel_variant === 'special_1eur'
          ? '/special-offer'
          : productContext.funnel_variant === 'special_free'
            ? '/special-offer-free'
            : '/offer/details'
      }?sg_order=${encodeURIComponent(orderId)}`,
      // NO fail_url on purpose: with one set, a declined card navigates the
      // form's iframe to it, so the buyer stares at our offer page rendered
      // inside a 320px frame (or, with a strict frame-src, "content is
      // blocked") instead of being told to try another card. Without it the
      // form stays put, reports `fail`, and the client re-opens a fresh order.
      // Cap is 10 keys / 380 chars each — locale and tier ride here so the
      // webhook never has to guess what was sold.
      order_metadata: boundOrderMetadata,
    });
    if (!isMerchantData(merchantData)) {
      console.error('[solidgate/create-session] merchant data builder returned an invalid result');
      return NextResponse.json({ error: 'Failed to initialize checkout' }, { status: 500 });
    }

    const { data: finalizedData, error: finalizeError } = await rpc(
      'finalize_solidgate_main_checkout_v2',
      {
        p_payment_environment: paymentEnvironment,
        p_session_id: sessionId,
        p_offer_slug: tier,
        p_product_slug: productCode,
        p_order_db_id: reservation.order_db_id,
        p_solidgate_order_id: orderId,
        p_amount_cents: amountCents,
        p_currency: currency.toLowerCase(),
        p_builder_token: builderToken,
        p_merchant_data: merchantData,
        p_customer_email: reservation.bound_customer_email,
        p_checkout_locale: reservation.bound_checkout_locale,
      },
    );
    if (finalizeError) {
      console.error('[solidgate/create-session] checkout payload finalization failed:', finalizeError.message);
      return NextResponse.json({ error: 'Failed to initialize checkout safely' }, { status: 503 });
    }
    if (
      !isMerchantData(finalizedData) ||
      finalizedData.merchant !== merchantData.merchant ||
      finalizedData.paymentIntent !== merchantData.paymentIntent ||
      finalizedData.signature !== merchantData.signature
    ) {
      console.error('[solidgate/create-session] checkout payload finalization mismatch');
      return NextResponse.json({ error: 'Failed to initialize checkout safely' }, { status: 500 });
    }

    return NextResponse.json({ merchantData: finalizedData, orderId, tracking: productContext });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[solidgate/create-session]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
