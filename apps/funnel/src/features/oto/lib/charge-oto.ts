/**
 * The one-click OTO charge, from the page's point of view.
 *
 * POST /recurring on the saved token; a 3DS step-up hands back a verify_url
 * the buyer must be REDIRECTED to (there is no inline equivalent). Solidgate
 * returns them to ?sg_confirm=<orderId>, which resumeSolidgateOto() finalises.
 */

import { attributionEventProperties, readStoredAttribution } from '@/features/analytics/lib/attribution';
import {
  lifecycleEventId,
  purchaseEventId,
  type PaymentProductContext,
} from '@/features/analytics/lib/checkout-context';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';
import {
  forgetAcceptedOtoRecoveryOrder,
  rememberAcceptedOtoRecoveryOrder,
} from './accepted-oto-recovery';

export type OtoPurchaseTracking = PaymentProductContext & {
  order_id: string;
  solidgate_order_id: string;
  transaction_id: string;
  event_id: string;
  $insert_id: string;
  subscription_id?: string;
} & Record<string, unknown>;

export interface OtoChargeOutcome {
  ok: boolean;
  /** The charge has not reached a terminal state; never emit Purchase yet. */
  pending?: boolean;
  /** Provider accepted the bound charge; advance while capture stays webhook-owned. */
  accepted?: boolean;
  /** Set when the buyer is being sent away for a 3DS challenge. */
  redirecting?: boolean;
  verifyUrl?: string;
  /** What was actually charged — the analytics events report it. */
  amountCents?: number;
  currency?: string;
  providerStatus?: string;
  orderAmountCents?: number;
  settledAmountCents?: number | null;
  /** What was actually sold (the server resolves it from the order row). */
  productSlug?: string;
  /** Canonical durable checkpoint returned by the progress RPC. */
  lastOtoStep?: string;
  /** Canonical server-derived continuation. */
  resumeTo?: string;
  /** Compatibility alias for older page code. */
  nextOto?: string;
  /** Canonical merchant/Solidgate order ID, also used as transaction_id. */
  orderId?: string;
  /** Complete product, price and attribution schema for conversion events. */
  tracking?: OtoPurchaseTracking;
  error?: string;
  code?: string;
}

interface SolidgateChargeResponse {
  ok?: boolean;
  pending?: boolean;
  accepted?: boolean;
  requiresAction?: boolean;
  verifyUrl?: string;
  orderId?: string;
  amountCents?: number;
  currency?: string;
  providerStatus?: string;
  orderAmountCents?: number;
  settledAmountCents?: number | null;
  productSlug?: string;
  lastOtoStep?: string;
  resumeTo?: string;
  nextOto?: string;
  subscriptionId?: string;
  tracking?: PaymentProductContext;
  error?: string;
  code?: string;
}

/** Includes response-body parsing; transport timeout is payment-ambiguous. */
export const OTO_CHARGE_REQUEST_TIMEOUT_MS = 15_000;

async function postOtoCharge(
  body: Record<string, unknown>,
  callerSignal?: AbortSignal,
): Promise<{ res: Response; data: SolidgateChargeResponse }> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) relayAbort();
  else callerSignal?.addEventListener('abort', relayAbort, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('OTO charge request timed out', 'TimeoutError')),
    OTO_CHARGE_REQUEST_TIMEOUT_MS,
  );

  try {
    const res = await fetch('/api/solidgate/charge-oto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    let data: SolidgateChargeResponse;
    try {
      data = (await res.json()) as SolidgateChargeResponse;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      data = {};
    }
    return { res, data };
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', relayAbort);
  }
}

/** Where Solidgate sends the buyer back to after a 3DS challenge. */
function currentOtoReturnUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('sg_confirm');
  url.hash = '';
  return url.toString();
}

export async function chargeOtoSolidgate(params: {
  slug: string;
  sessionId: string;
  /**
   * Fired once when Solidgate reports the charge as still settling. The page
   * should switch from its generic "processing" state to the calm
   * payment-pending notice — this is NOT a decline.
   */
  onPending?: () => void;
}): Promise<OtoChargeOutcome> {
  const attribution = readStoredAttribution();
  let response: Awaited<ReturnType<typeof postOtoCharge>>;
  try {
    response = await postOtoCharge({
      sessionId: params.sessionId,
      slug: params.slug,
      attribution,
      returnUrl: currentOtoReturnUrl(),
    });
  } catch {
    // The server or PSP may have accepted the exact leased order before the
    // response was lost. Keep this as pending; a retry reconciles that same ID.
    params.onPending?.();
    return { ok: false, pending: true };
  }
  const { res, data } = response;

  if (res.ok && data.ok) {
    if (data.orderId) forgetAcceptedOtoRecoveryOrder(params.sessionId, data.orderId);
    return successfulOutcome(data);
  }

  // 202 is not a decline. Once the server marks it accepted, the durable order
  // and next-step state are committed and capture/entitlement are completed by
  // the webhook. Do not wait or run a second confirmation loop in the browser.
  if (res.status === 202 && data.pending) {
    if (data.accepted) {
      const orderId = data.orderId;
      const productSlug = data.productSlug ?? params.slug;
      if (
        !orderId
        || !rememberAcceptedOtoRecoveryOrder({
          sessionId: params.sessionId,
          orderId,
          productSlug,
        })
      ) {
        params.onPending?.();
        return { ok: false, pending: true, orderId };
      }
      return {
        ok: false,
        pending: true,
        accepted: true,
        amountCents: data.amountCents,
        currency: data.currency,
        productSlug: data.productSlug,
        orderId: data.orderId,
        lastOtoStep: data.lastOtoStep,
        resumeTo: data.resumeTo,
        nextOto: data.nextOto,
        providerStatus: data.providerStatus,
        orderAmountCents: data.orderAmountCents,
        settledAmountCents: data.settledAmountCents,
      };
    }
    params.onPending?.();
    return {
      ok: false,
      pending: true,
      amountCents: data.amountCents,
      currency: data.currency,
      productSlug: data.productSlug,
      orderId: data.orderId,
      lastOtoStep: data.lastOtoStep,
      resumeTo: data.resumeTo,
      nextOto: data.nextOto,
      providerStatus: data.providerStatus,
      orderAmountCents: data.orderAmountCents,
      settledAmountCents: data.settledAmountCents,
    };
  }

  if (res.ok && data.requiresAction && data.verifyUrl && data.orderId) {
    // The server already bound this exact order ID into Solidgate's validated
    // same-origin success_url. The ACS page owns the tab from here.
    rememberAcceptedOtoRecoveryOrder({
      sessionId: params.sessionId,
      orderId: data.orderId,
      productSlug: data.productSlug ?? params.slug,
    });
    window.location.assign(data.verifyUrl);
    return { ok: false, redirecting: true };
  }

  return { ok: false, error: data.error ?? 'Payment failed', code: data.code };
}

/**
 * Finalises an OTO the buyer completed via a 3DS redirect. Call on mount when
 * ?sg_confirm is present; the server re-reads the order from Solidgate, so a
 * forged query param buys nothing.
 */
export async function resumeSolidgateOto(params: {
  slug: string;
  sessionId: string;
  orderId: string;
  signal?: AbortSignal;
}): Promise<OtoChargeOutcome> {
  const attribution = readStoredAttribution();
  let response: Awaited<ReturnType<typeof postOtoCharge>>;
  try {
    response = await postOtoCharge(
      {
        sessionId: params.sessionId,
        slug: params.slug,
        confirmOrderId: params.orderId,
        attribution,
      },
      params.signal,
    );
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return { ok: false, pending: true, orderId: params.orderId };
  }
  const { res, data } = response;
  if (res.ok && data.ok) {
    forgetAcceptedOtoRecoveryOrder(params.sessionId, params.orderId);
    return successfulOutcome(data);
  }

  if (res.ok && data.requiresAction && data.verifyUrl && data.orderId) {
    rememberAcceptedOtoRecoveryOrder({
      sessionId: params.sessionId,
      orderId: data.orderId,
      productSlug: data.productSlug ?? params.slug,
    });
    return {
      ok: false,
      redirecting: true,
      verifyUrl: data.verifyUrl,
      orderId: data.orderId,
    };
  }

  if (res.status === 202 && data.pending) {
    if (data.accepted) {
      const orderId = data.orderId ?? params.orderId;
      const productSlug = data.productSlug ?? params.slug;
      if (!rememberAcceptedOtoRecoveryOrder({
        sessionId: params.sessionId,
        orderId,
        productSlug,
      })) {
        return { ok: false, pending: true, orderId };
      }
      return {
        ok: false,
        pending: true,
        accepted: true,
        amountCents: data.amountCents,
        currency: data.currency,
        productSlug: data.productSlug,
        orderId: data.orderId ?? params.orderId,
        lastOtoStep: data.lastOtoStep,
        resumeTo: data.resumeTo,
        nextOto: data.nextOto,
        providerStatus: data.providerStatus,
        orderAmountCents: data.orderAmountCents,
        settledAmountCents: data.settledAmountCents,
      };
    }
    return {
      ok: false,
      pending: true,
      orderId: data.orderId ?? params.orderId,
      amountCents: data.amountCents,
      currency: data.currency,
      productSlug: data.productSlug,
      providerStatus: data.providerStatus,
      orderAmountCents: data.orderAmountCents,
      settledAmountCents: data.settledAmountCents,
    };
  }

  if (res.status === 429 || res.status >= 500) {
    return { ok: false, pending: true, orderId: params.orderId };
  }

  forgetAcceptedOtoRecoveryOrder(params.sessionId, params.orderId);
  return { ok: false, error: data.error ?? 'Payment failed', code: data.code };
}

function successfulOutcome(data: SolidgateChargeResponse): OtoChargeOutcome {
  const orderId = data.orderId;
  let tracking: OtoPurchaseTracking | undefined;
  if (orderId && data.tracking) {
    const eventId = purchaseEventId(orderId);
    tracking = {
      ...data.tracking,
      ...attributionEventProperties(),
      order_id: orderId,
      solidgate_order_id: orderId,
      transaction_id: orderId,
      event_id: eventId,
      $insert_id: eventId,
      ...(data.subscriptionId ? { subscription_id: data.subscriptionId } : {}),
    };
  }
  return {
    ok: true,
    orderId,
    amountCents: data.amountCents,
    currency: data.currency,
    productSlug: data.productSlug,
    lastOtoStep: data.lastOtoStep,
    resumeTo: data.resumeTo,
    nextOto: data.nextOto,
    tracking,
  };
}

/** Revenue conversion properties. Throws no data away when an older response is encountered. */
export function otoPurchaseEventProperties(
  outcome: OtoChargeOutcome,
  sessionId: string | null | undefined,
): Record<string, unknown> {
  const amountCents = outcome.tracking?.amount_cents ?? outcome.amountCents ?? 0;
  const currency = outcome.tracking?.currency ?? outcome.currency ?? '';
  return {
    ...attributionEventProperties(),
    ...(outcome.tracking ?? {}),
    session_id: sessionId ?? undefined,
    product: outcome.tracking?.product ?? outcome.productSlug,
    product_category: 'oto',
    amount_cents: amountCents,
    value: purchaseEventValue(amountCents, currency),
    currency: currency.toUpperCase(),
  };
}

/** Give each secondary OTO lifecycle event its own deterministic insert ID. */
export function otoLifecycleEventProperties(
  outcome: OtoChargeOutcome,
  sessionId: string | null | undefined,
  eventName: string,
): Record<string, unknown> {
  const properties = otoPurchaseEventProperties(outcome, sessionId);
  if (!outcome.orderId) return properties;
  const eventId = lifecycleEventId(eventName, outcome.orderId);
  return { ...properties, event_id: eventId, $insert_id: eventId };
}

export interface SolidgateConfirmOrigin {
  orderId: string;
  /** Exact history entry on which this confirmation marker was observed. */
  href: string;
}

/** Reads a marker without consuming it; the originating history entry owns it. */
export function readSolidgateConfirmOrigin(): SolidgateConfirmOrigin | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const orderId = url.searchParams.get('sg_confirm');
  if (!orderId) return null;
  return { orderId, href: url.toString() };
}

/** True only while the browser is still on the exact page/order that began the read. */
export function isCurrentSolidgateConfirmOrigin(origin: SolidgateConfirmOrigin): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.href === origin.href;
}

/** Clears only its own marker and preserves Next.js' existing history state. */
export function clearSolidgateConfirmOrigin(origin: SolidgateConfirmOrigin): boolean {
  if (!isCurrentSolidgateConfirmOrigin(origin)) return false;
  const url = new URL(origin.href);
  if (url.searchParams.get('sg_confirm') !== origin.orderId) return false;
  url.searchParams.delete('sg_confirm');
  window.history.replaceState(window.history.state, '', url.toString());
  return true;
}

export function otoPmInfoUrl(sessionId: string): string {
  return `/api/solidgate/pm-info?sessionId=${encodeURIComponent(sessionId)}`;
}
