import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  PAYMENT_COOKIE_NAME,
  verifyPaymentCookie,
} from '@repo/shared/payment-cookie';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { createClient } from '@repo/shared/supabase/server';
import { getSessionVault, type SolidgateVaultEntry } from '@repo/shared/solidgate/session-vault';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { routing } from '@repo/i18n/routing';
import { FUNNEL_CODE } from '@/features/analytics/lib/checkout-context';
import { MAIN_PLAN_SLUGS } from './checkout-tiers';

/**
 * Who may spend the card saved against a funnel session.
 *
 * The Solidgate counterpart of authorizePaymentSessionAccess. Two ways in:
 *
 *   cookie  — the HMAC payment_access cookie issued by the grant route, whose
 *             id is the Solidgate order_id of the checkout purchase. It must
 *             name this session AND match an orders row for it, so a stolen or
 *             forged cookie buys nothing.
 *   account — the buyer is signed in and owns the session (they came back later).
 *
 * Returning the vault here is the point: a caller can only charge a token it was
 * handed, so no route can charge a card it did not prove ownership of.
 */

type SolidgateDeniedAccess = { ok: false; response: NextResponse };
type SolidgateAuthorizedIdentity = {
  ok: true;
  userId: string | null;
  resolvedVia: 'cookie' | 'account';
};

export type SolidgateAccess =
  | (SolidgateAuthorizedIdentity & { vault: SolidgateVaultEntry })
  | SolidgateDeniedAccess;

export type SolidgateIdentityAccess =
  | (SolidgateAuthorizedIdentity & { vault: null })
  | SolidgateDeniedAccess;

interface SolidgateAccessParams {
  sessionId: string;
  sessionUserId: string | null;
  /** False for non-charging writes that need ownership but no saved card. */
  requireCardToken?: boolean;
}

const REUSABLE_MAIN_ORDER_STATUSES = new Set([
  'completed',
  'trialing',
  'active',
  // These are subscription-lifecycle states, not reversals of the initial
  // checkout authorization. OTO1 deliberately cancels the main subscription.
  'past_due',
  'canceled',
]);
// Every routing locale is a legitimate checkout locale. Derived, not copied:
// a duplicated literal meant a newly-enabled locale silently failed one-click
// charges here while checkout itself worked.
const CHECKOUT_LOCALES: ReadonlySet<string> = new Set<string>(routing.locales);

const MAIN_SOURCE_COLUMNS = [
  'id',
  'payment_environment',
  'psp',
  'solidgate_order_id',
  'session_id',
  'user_id',
  'product_name',
  'product_slug',
  'status',
  'amount_cents',
  'currency',
  'tracking_metadata',
  'solidgate_original_amount_cents',
  'solidgate_payment_status',
  'solidgate_payment_action',
  'solidgate_refunded_amount_cents',
  'solidgate_chargeback_id',
  'solidgate_chargeback_status',
  'solidgate_chargeback_amount_cents',
  'solidgate_subscription_id',
  'solidgate_customer_email',
  'solidgate_checkout_locale',
  'solidgate_product_id',
  'solidgate_checkout_identity_bound_at',
  'solidgate_checkout_identity_legacy',
].join(',');

type MainVaultSourceOrder = {
  id: string;
  payment_environment: string;
  psp: string;
  solidgate_order_id: string | null;
  session_id: string | null;
  user_id: string | null;
  product_name: string | null;
  product_slug: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  tracking_metadata: unknown;
  solidgate_original_amount_cents: number | null;
  solidgate_payment_status: string | null;
  solidgate_payment_action: string | null;
  solidgate_refunded_amount_cents: number;
  solidgate_chargeback_id: string | null;
  solidgate_chargeback_status: string | null;
  solidgate_chargeback_amount_cents: number;
  solidgate_subscription_id: string | null;
  solidgate_customer_email: string | null;
  solidgate_checkout_locale: string | null;
  solidgate_product_id: string | null;
  solidgate_checkout_identity_bound_at: string | null;
  solidgate_checkout_identity_legacy: boolean;
};

function noSavedCardResponse(): SolidgateDeniedAccess {
  return {
    ok: false,
    response: NextResponse.json(
      { error: 'No saved card for this session', code: 'no_saved_card' },
      { status: 409 },
    ),
  };
}

function isCanonicalMainSnapshot(order: MainVaultSourceOrder, sessionId: string): boolean {
  const metadata = order.tracking_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const entries = Object.entries(metadata);
  if (
    entries.length === 0
    || entries.length > 10
    || entries.some(([, value]) => typeof value !== 'string' || value.length > 380)
  ) return false;
  const snapshot = metadata as Record<string, string>;
  const tier = snapshot.product_slug;
  const expectedVariant = tier === 'special_1eur' || tier === 'special_free' ? tier : 'main';
  const orderIdParts = order.solidgate_order_id?.split(':') ?? [];

  return (
    order.psp === 'solidgate'
    && order.product_name === SOLIDGATE_PRODUCT_CODES.main
    && order.product_slug === SOLIDGATE_PRODUCT_CODES.main
    && order.session_id === sessionId
    && !order.solidgate_checkout_identity_legacy
    && typeof order.solidgate_checkout_identity_bound_at === 'string'
    && order.solidgate_checkout_identity_bound_at.length > 0
    && typeof order.solidgate_customer_email === 'string'
    && order.solidgate_customer_email === order.solidgate_customer_email.trim().toLowerCase()
    && order.solidgate_customer_email.length >= 3
    && order.solidgate_customer_email.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.solidgate_customer_email)
    && typeof order.solidgate_checkout_locale === 'string'
    && CHECKOUT_LOCALES.has(order.solidgate_checkout_locale)
    && typeof order.solidgate_product_id === 'string'
    && order.solidgate_product_id.trim().length > 0
    && typeof order.solidgate_subscription_id === 'string'
    && order.solidgate_subscription_id.trim().length > 0
    && /^[a-z]{3}$/.test(order.currency)
    && MAIN_PLAN_SLUGS.has(tier)
    && snapshot.funnel_code === FUNNEL_CODE
    && snapshot.funnel_variant === expectedVariant
    && snapshot.session_id === sessionId
    && typeof snapshot.price_id === 'string'
    && snapshot.price_id.trim().length > 0
    && !Object.prototype.hasOwnProperty.call(snapshot, 'locale')
    && orderIdParts.length === 3
    && orderIdParts[0] === sessionId
    && orderIdParts[1] === tier
    && /^[1-9][0-9]{0,8}$/.test(orderIdParts[2] ?? '')
  );
}

function hasReusableMainAuthorization(order: MainVaultSourceOrder): boolean {
  if (
    (!REUSABLE_MAIN_ORDER_STATUSES.has(order.status) && order.status !== 'pending')
    || order.solidgate_payment_status === 'void_ok'
    || order.solidgate_chargeback_id !== null
    || order.solidgate_chargeback_status !== null
    || order.solidgate_chargeback_amount_cents !== 0
  ) return false;

  const gross = order.solidgate_original_amount_cents;
  const net = order.amount_cents;
  const refunded = order.solidgate_refunded_amount_cents;
  if (
    !Number.isSafeInteger(gross)
    || !Number.isSafeInteger(net)
    || !Number.isSafeInteger(refunded)
    || (gross ?? -1) < 0
    || net < 0
    || refunded < 0
  ) return false;

  // A still-pending opener row is reusable only as the provider-confirmed paid
  // authorization whose immediate capture (settle_interval 0) is in flight —
  // the accepted auth_ok handoff that puts the buyer on OTO1 before settle. A
  // reversal flips the row to failed/void and this gate closes on next use.
  if (order.status === 'pending') {
    return (
      order.solidgate_payment_action === 'auth_settle'
      && order.solidgate_payment_status === 'auth_ok'
      && gross !== null
      && gross > 0
      && refunded === 0
      && net === gross
    );
  }

  // The free main trial has no captured money. Its exact zero-amount auth is
  // the authorization that produced the reusable card token.
  if (order.solidgate_payment_action === 'auth_0_amount') {
    return (
      order.solidgate_payment_status === 'auth_ok'
      && gross === 0
      && net === 0
      && refunded === 0
    );
  }
  if (order.solidgate_payment_action !== 'auth_settle' || !gross || gross <= 0) return false;

  if (
    order.solidgate_payment_status === 'settle_ok'
    || order.solidgate_payment_status === 'partial_settled'
  ) {
    return refunded === 0 && net === gross;
  }

  // Solidgate uses `refunded` for both partial and full refunds. A partial
  // refund remains usable only while the durable ledger is arithmetically
  // exact; a full refund has net=0/order.status=refunded and is rejected.
  return (
    order.solidgate_payment_status === 'refunded'
    && refunded > 0
    && refunded < gross
    && net === gross - refunded
  );
}

export function authorizeSolidgateSession(
  params: SolidgateAccessParams & { requireCardToken: false },
): Promise<SolidgateIdentityAccess>;
export function authorizeSolidgateSession(params: SolidgateAccessParams): Promise<SolidgateAccess>;
export async function authorizeSolidgateSession(
  params: SolidgateAccessParams,
): Promise<SolidgateAccess | SolidgateIdentityAccess> {
  const { sessionId, sessionUserId, requireCardToken = true } = params;
  const supabase = getSupabaseAdminClient();
  const paymentEnvironment = currentPaymentEnvironment();
  let identity: Omit<SolidgateAuthorizedIdentity, 'ok'> | null = null;
  let cookieOrderId: string | null = null;

  // Account path.
  try {
    const ssr = await createClient();
    const { data, error } = await ssr.auth.getUser();
    if (error && error.name !== 'AuthSessionMissingError') {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Failed to verify user' }, { status: 500 }),
      };
    }
    const user = data?.user ?? null;
    if (user) {
      if (sessionUserId && sessionUserId !== user.id) {
        return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
      }
      if (sessionUserId === user.id) {
        identity = { userId: user.id, resolvedVia: 'account' };
      }
    }
  } catch {
    // Fall through to the cookie path.
  }

  // Cookie path. The cookie names a main order; that order must exist and
  // belong to this session. This remains mandatory for unlinked sessions.
  if (!identity) {
    const jar = await cookies();
    const raw = jar.get(PAYMENT_COOKIE_NAME)?.value;
    if (!raw) {
      return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    const verified = await verifyPaymentCookie(raw);
    if (
      !verified
      || verified.sessionId !== sessionId
      || verified.kind !== 'pi'
      || !verified.paymentIntentId
    ) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    const paymentOrderId = verified.paymentIntentId;

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id')
      .eq('payment_environment', paymentEnvironment)
      .eq('solidgate_order_id', paymentOrderId)
      .eq('session_id', sessionId)
      .maybeSingle();
    if (orderError) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'Failed to verify payment ownership' }, { status: 500 }),
      };
    }
    if (!order) {
      return { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    cookieOrderId = paymentOrderId;
    identity = { userId: sessionUserId, resolvedVia: 'cookie' };
  }

  if (!requireCardToken) return { ok: true, vault: null, ...identity };

  const vault = await getSessionVault(supabase, sessionId, paymentEnvironment);
  if (
    !vault?.cardToken
    || !vault.sourceOrderId
    || vault.paymentEnvironment !== paymentEnvironment
    || vault.sessionId !== sessionId
    || vault.customerAccountId !== sessionId
  ) {
    // No saved card = nothing to charge. Identity was still proven first so
    // this condition never grants information or progress to a deep link.
    return noSavedCardResponse();
  }

  // The vault is only a pointer. Re-read the exact main order that produced
  // its token and prove the immutable checkout identity plus current financial
  // state before any caller can receive that reusable credential.
  const { data: sourceData, error: sourceError } = await supabase
    .from('orders')
    .select(MAIN_SOURCE_COLUMNS)
    .eq('id', vault.sourceOrderId)
    .eq('payment_environment', paymentEnvironment)
    .eq('psp', 'solidgate')
    .eq('session_id', sessionId)
    .eq('product_name', SOLIDGATE_PRODUCT_CODES.main)
    .eq('product_slug', SOLIDGATE_PRODUCT_CODES.main)
    .maybeSingle();
  if (sourceError) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Failed to verify saved card', code: 'saved_card_verification_failed' },
        { status: 500 },
      ),
    };
  }
  const source = sourceData as MainVaultSourceOrder | null;
  const identityOwnsSource = identity.resolvedVia === 'cookie'
    ? source?.solidgate_order_id === cookieOrderId
    : Boolean(identity.userId && source?.user_id === identity.userId);
  if (
    !source
    || source.id !== vault.sourceOrderId
    || source.payment_environment !== paymentEnvironment
    || !identityOwnsSource
    || !isCanonicalMainSnapshot(source, sessionId)
    || !hasReusableMainAuthorization(source)
  ) return noSavedCardResponse();

  return { ok: true, vault, ...identity };
}
