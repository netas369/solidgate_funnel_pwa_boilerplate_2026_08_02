// One-click charges on a saved card — the OTO upsell engine.
//
// Solidgate uses POST /recurring against the `recurring_token` captured at
// checkout, in two shapes:
//
//   amount-based   → a one-off charge (the PDF/lifetime OTOs). Needs
//                    amount + currency; carries no catalog product.
//   product-based  → starts a NEW subscription on the saved card (the add-on
//                    OTO). Needs product_id + customer_account_id, no amount:
//                    price, billing period and trial all come from the product.
//
// payment_type is the CIT/MIT switch and must match the credential that created
// the recurring token:
//   '1-click' = customer-present card/network-token purchase.
//   'rebill'  = Apple Pay / Google Pay token reuse explicitly approved for this
//               integration by Solidgate Support. It remains an MIT and thus
//               requires the checkout's credential-on-file/upsell mandate.
// The caller derives this value from Solidgate's signed
// card_token.original_payment_method and never from browser input.

import { SolidgateClient } from './client';

export type SolidgateRecurringPaymentType = '1-click' | 'rebill';

/** A 3DS challenge on a token charge is a REDIRECT, not an inline modal. */
export interface SolidgateChargeResult {
  /**
   * 'pending' means Solidgate is still working and we stopped waiting — the
   * charge may yet succeed, so the caller must NOT treat it as a decline.
   */
  status: 'success' | 'requires_action' | 'failed' | 'voided' | 'pending';
  /** Merchant order identifier echoed by Solidgate (not the local request input). */
  providerOrderId?: string;
  orderId: string;
  /** Present on success. */
  subscriptionId?: string | null;
  amount?: number;
  orderAmount?: number;
  settledAmount?: number | null;
  currency?: string;
  /** Provider-side identity returned by /recurring or /status. */
  productId?: string;
  customerAccountId?: string;
  providerStatus?: string;
  /** Present when status = 'requires_action': send the buyer here. */
  verifyUrl?: string;
  /** Conflicting provider URL aliases must never fall back to cached ACS state. */
  verifyUrlConflict?: true;
  /** Present when status = 'failed' or 'voided'. */
  errorCode?: string;
  errorMessage?: string;
}

export interface SolidgateOrderPaymentState {
  status?: string;
  /** Original amount requested on the order, in minor units. */
  amount?: number;
  /** Amount actually captured, in minor units. */
  settled_amount?: number | null;
  subscription_id?: string | null;
}

export interface SolidgateTransactionPaymentState {
  id?: string;
  operation?: string;
  status?: string;
  amount?: number;
  currency?: string;
}

export interface SolidgateCaptureState {
  order?: SolidgateOrderPaymentState & { currency?: string };
  transaction?: SolidgateTransactionPaymentState;
  transactions?: Record<string, SolidgateTransactionPaymentState>;
}

interface SolidgateOrderResponse {
  order?: {
    order_id?: string;
    status?: string;
    amount?: number;
    settled_amount?: number | null;
    currency?: string;
    subscription_id?: string | null;
    product_id?: string;
    customer_account_id?: string;
  };
  transaction?: SolidgateTransactionPaymentState;
  transactions?: Record<string, SolidgateTransactionPaymentState>;
  verify_url?: string;
  /** Undocumented Support terminology; canonical API field is `verify_url`. */
  verify_link?: string;
  // `messages` is a flat array on payment declines but a field-keyed object on
  // request validation errors (e.g. 2.01), so accept both shapes.
  error?: {
    code?: string;
    messages?: string[] | Record<string, string[]>;
    recommended_message_for_user?: string;
  };
}

export interface SolidgateVerifyUrlResolution {
  verifyUrl?: string;
  conflict: boolean;
}

export function resolveSolidgateVerifyUrl(
  fields: { verify_url?: unknown; verify_link?: unknown },
): SolidgateVerifyUrlResolution {
  const canonical = typeof fields.verify_url === 'string' && fields.verify_url.length > 0
    ? fields.verify_url
    : undefined;
  const compatibility = typeof fields.verify_link === 'string' && fields.verify_link.length > 0
    ? fields.verify_link
    : undefined;
  // Conflicting signed fields are not safe redirect evidence. Keep the exact
  // order pending so /status or the webhook can provide the canonical URL.
  if (canonical && compatibility && canonical !== compatibility) {
    return { conflict: true };
  }
  return { verifyUrl: canonical ?? compatibility, conflict: false };
}

/** First human-readable message out of either `messages` shape. */
function solidgateErrorMessage(
  error: NonNullable<SolidgateOrderResponse['error']>,
): string | undefined {
  if (error.recommended_message_for_user) return error.recommended_message_for_user;
  const messages = error.messages;
  if (Array.isArray(messages)) return messages[0];
  if (messages && typeof messages === 'object') return Object.values(messages).flat()[0];
  return undefined;
}

export type SolidgatePaymentDecision = 'success' | 'pending' | 'failed' | 'voided';

const PENDING_STATUSES = new Set(['3ds_verify', 'processing', 'created']);
// A freshly returned `/recurring` envelope can carry the challenge URL while
// the nested order is still `created`/`processing`. A later `/status` response
// is different: only its explicit `3ds_verify` state proves that an attached
// URL is still actionable. In particular, `auth_ok` is a completed
// authorization state, never a reason to send the buyer back to an old ACS.
const SUBMISSION_VERIFICATION_STATUSES = new Set([
  '3ds_verify',
  'processing',
  'created',
]);
const STATUS_VERIFICATION_STATUSES = new Set(['3ds_verify']);

/**
 * Returns capture evidence using the fields the card API actually exposes.
 *
 * `/recurring` and `/status` do not publish `order.settled_amount`. A
 * `settle_ok` order is, by definition, fully settled; `partial_settled` needs
 * an exact sum of successful settle transactions. The singular transaction is
 * the latest transaction and is also commonly present in the transactions
 * map, so prefer the map and only fall back to the singular shape.
 */
export function solidgateCapturedAmount(
  response: SolidgateCaptureState,
  expectedAmount: number,
): number | null {
  const order = response.order;
  if (!order) return null;

  if (order.status === 'settle_ok') {
    return order.amount === expectedAmount ? expectedAmount : null;
  }
  if (
    order.status === 'auth_ok' &&
    expectedAmount === 0 &&
    order.amount === 0 &&
    Boolean(order.subscription_id)
  ) {
    return 0;
  }
  if (order.status !== 'partial_settled') {
    return typeof order.settled_amount === 'number' ? order.settled_amount : null;
  }

  // Some channels have returned this extension even though the checked-in
  // card schema omits it. It is signed provider data, so it remains valid
  // observed capture evidence; the caller still requires an exact match.
  if (typeof order.settled_amount === 'number') {
    return Number.isSafeInteger(order.settled_amount) && order.settled_amount >= 0
      ? order.settled_amount
      : null;
  }

  const mapped = Object.values(response.transactions ?? {});
  const candidates = mapped.length > 0
    ? mapped
    : response.transaction
      ? [response.transaction]
      : [];
  const settles = candidates.filter(
    (transaction) => transaction.operation === 'settle' && transaction.status === 'success',
  );
  if (settles.length === 0) return null;

  const orderCurrency = order.currency?.toLowerCase();
  let total = 0;
  for (const transaction of settles) {
    if (
      !Number.isSafeInteger(transaction.amount) ||
      (transaction.amount ?? -1) < 0 ||
      !transaction.currency ||
      !orderCurrency ||
      transaction.currency.toLowerCase() !== orderCurrency
    ) return null;
    total += transaction.amount!;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * Converts Solidgate's order lifecycle into our entitlement decision.
 *
 * `auth_ok` only reserves funds. A positive order is not paid until capture
 * (`settle_ok`). The one exception is a genuine zero-value subscription trial:
 * there is nothing to capture, but the successful auth creates a subscription.
 */
export function classifySolidgatePayment(
  order: SolidgateOrderPaymentState | undefined,
  expectedAmount: number,
): SolidgatePaymentDecision {
  const status = order?.status;

  if (!status || PENDING_STATUSES.has(status)) return 'pending';
  if (status === 'void_ok') return 'voided';
  // This helper is used by the card `/recurring` and `/status` endpoints.
  // `approved` belongs to the separate APM gate API and must not be invented
  // in card-response mocks.
  if (status === 'settle_ok') return 'success';

  if (status === 'partial_settled') {
    // `amount` is the original authorisation amount. Only `settled_amount`
    // proves how much was captured. An incomplete/omitted capture is
    // ambiguous rather than a decline: keep the same provider order open so
    // its webhook/status transition can finish it, and never submit a second
    // charge for the remainder.
    return typeof order?.settled_amount === 'number' && order.settled_amount === expectedAmount
      ? 'success'
      : 'pending';
  }

  if (status === 'auth_ok') {
    return expectedAmount === 0 && order?.amount === 0 && Boolean(order.subscription_id)
      ? 'success'
      : 'pending';
  }

  return 'failed';
}

function interpret(
  res: SolidgateOrderResponse,
  orderId: string,
  expectedAmount: number,
  source: 'submission' | 'status',
): SolidgateChargeResult {
  const verifyUrlResolution = resolveSolidgateVerifyUrl(res);
  const verifyUrl = verifyUrlResolution.verifyUrl;
  // An error response with no order at all means Solidgate REFUSED the request
  // (bad token, invalid body, unknown order) — nothing is settling. Without
  // this branch `!status` classifies as 'pending', settle() polls a
  // nonexistent order, and the real error is swallowed into an eternal
  // "still settling" answer.
  if (!res.order && res.error) {
    return {
      status: 'failed',
      orderId,
      ...(verifyUrlResolution.conflict && { verifyUrlConflict: true as const }),
      // Merchant received a definite provider response and no order identity
      // exists to settle later. Keep this distinct from transport ambiguity so
      // the atomic opener may retire only this proven no-charge attempt.
      providerStatus: 'request_rejected',
      errorCode: res.error.code,
      errorMessage: solidgateErrorMessage(res.error) ?? 'Payment declined',
    };
  }

  const capturedAmount = solidgateCapturedAmount(res, expectedAmount);
  const normalizedOrder = res.order
    ? {
        ...res.order,
        ...(capturedAmount !== null && { settled_amount: capturedAmount }),
      }
    : undefined;
  const decision = classifySolidgatePayment(normalizedOrder, expectedAmount);
  const providerIdentity = {
    providerOrderId: res.order?.order_id,
    customerAccountId: res.order?.customer_account_id,
    ...(verifyUrlResolution.conflict && { verifyUrlConflict: true as const }),
  };

  if (decision === 'success') {
    return {
      status: 'success',
      orderId,
      ...providerIdentity,
      subscriptionId: res.order?.subscription_id ?? null,
      amount: capturedAmount ?? res.order?.amount,
      orderAmount: res.order?.amount,
      settledAmount: capturedAmount,
      currency: res.order?.currency,
      productId: res.order?.product_id,
      providerStatus: res.order?.status,
    };
  }

  // A challenge hands back the issuer's ACS page. There is no inline
  // confirmCardPayment equivalent: the customer must visit verify_url.
  if (
    verifyUrl
    && decision === 'pending'
    && (source === 'submission'
      ? SUBMISSION_VERIFICATION_STATUSES
      : STATUS_VERIFICATION_STATUSES
    ).has(res.order?.status ?? '')
  ) {
    return {
      status: 'requires_action',
      orderId,
      ...providerIdentity,
      verifyUrl,
      subscriptionId: res.order?.subscription_id ?? null,
      amount: capturedAmount ?? res.order?.amount,
      orderAmount: res.order?.amount,
      settledAmount: capturedAmount,
      currency: res.order?.currency,
      productId: res.order?.product_id,
      providerStatus: res.order?.status,
    };
  }

  // ⚠️ A token charge is ASYNCHRONOUS. /recurring answers `processing` and the
  // order settles a beat later, so "not yet successful" is NOT a decline —
  // treating it as one marks a charged customer as failed and hands them
  // nothing. Only an explicit failure status (or error) is a decline.
  if (decision === 'pending') {
    return {
      status: 'pending',
      orderId,
      ...providerIdentity,
      subscriptionId: res.order?.subscription_id ?? null,
      amount: capturedAmount ?? res.order?.amount,
      orderAmount: res.order?.amount,
      settledAmount: capturedAmount,
      currency: res.order?.currency,
      productId: res.order?.product_id,
      providerStatus: res.order?.status,
    };
  }

  if (decision === 'voided') {
    return {
      status: 'voided',
      orderId,
      ...providerIdentity,
      subscriptionId: res.order?.subscription_id ?? null,
      amount: capturedAmount ?? res.order?.amount,
      orderAmount: res.order?.amount,
      settledAmount: capturedAmount,
      currency: res.order?.currency,
      productId: res.order?.product_id,
      providerStatus: res.order?.status ?? 'void_ok',
      errorCode: 'void_ok',
      errorMessage: 'Payment authorization was voided',
    };
  }

  return {
    status: 'failed',
    orderId,
    ...providerIdentity,
    subscriptionId: res.order?.subscription_id ?? null,
    amount: capturedAmount ?? res.order?.amount,
    orderAmount: res.order?.amount,
    settledAmount: capturedAmount,
    currency: res.order?.currency,
    productId: res.order?.product_id,
    // Preserve an actual card-order terminal status. Callers use this durable
    // evidence to retire the exact provider identity and may mint N+1 only for
    // an allowlisted zero-net terminal state. Dropping `auth_failed` here left
    // every normal saved-card decline permanently stuck as generic `failed`.
    providerStatus: res.order?.status,
    errorCode: res.error?.code,
    errorMessage: (res.error && solidgateErrorMessage(res.error)) ?? 'Payment declined',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for an async token charge to reach a terminal state.
 *
 * Solidgate settles within a second or two, but the request must not hang: if it
 * is still working when we give up we return `pending`, leaving the order open
 * for the webhook to finalise rather than lying to the customer either way.
 */
async function settle(
  client: SolidgateClient,
  orderId: string,
  first: SolidgateOrderResponse,
  expectedAmount: number,
  { attempts = 8, intervalMs = 1000 } = {},
): Promise<SolidgateChargeResult> {
  let result = interpret(first, orderId, expectedAmount, 'submission');
  let verifyUrlConflictObserved = result.verifyUrlConflict === true;
  for (let i = 0; i < attempts && result.status === 'pending'; i++) {
    await sleep(intervalMs);
    const status = await client.status<SolidgateOrderResponse>({ order_id: orderId });
    result = interpret(status, orderId, expectedAmount, 'status');
    verifyUrlConflictObserved ||= result.verifyUrlConflict === true;
    if (result.status === 'pending' && verifyUrlConflictObserved && !result.verifyUrl) {
      result = { ...result, verifyUrlConflict: true };
    }
  }
  return result;
}

/** One-off charge on a saved card (lifetime + the PDF OTOs). */
export async function chargeSavedCard(
  client: SolidgateClient,
  params: {
    orderId: string;
    recurringToken: string;
    /** Derived server-side from the token's original payment method. */
    paymentType: SolidgateRecurringPaymentType;
    amount: number;
    currency: string;
    orderDescription: string;
    customerAccountId: string;
    customerEmail: string;
    ipAddress: string;
    /** Browser Accept header — 3DS 2.0 browser data for the frictionless flow. */
    headerAccept?: string;
    /** Browser User-Agent — 3DS 2.0 browser data for the frictionless flow. */
    userAgent?: string;
    /** Same-origin funnel/PWA return URL for a possible 3DS redirect. */
    successUrl?: string;
    /** Optional distinct failure return; defaults to the exact-order success route. */
    failUrl?: string;
    metadata?: Record<string, string>;
    /** Route-owned workflows can disable nested status polling. */
    settlement?: { attempts?: number; intervalMs?: number };
  },
): Promise<SolidgateChargeResult> {
  // All products use the static descriptor configured on the Solidgate
  // channel / connector. Never send a per-payment descriptor override.
  // /recurring also rejects dynamic_descriptor (schema + sandbox 2.01
  // "Invalid request body", verified 2026-07-13).
  const res = await client.recurring<SolidgateOrderResponse>({
    order_id: params.orderId,
    recurring_token: params.recurringToken,
    amount: params.amount,
    currency: params.currency.toUpperCase(),
    order_description: params.orderDescription,
    // 'auth' + settle_interval 0 = authorise and capture immediately.
    type: 'auth',
    settle_interval: 0,
    payment_type: params.paymentType,
    customer_account_id: params.customerAccountId,
    customer_email: params.customerEmail,
    ip_address: params.ipAddress,
    platform: 'WEB',
    // Optional at the API level, but without them the issuer cannot run the
    // frictionless 3DS 2.0 assessment on token charges — more challenges and
    // declines (Solidgate UAT 2026-07-24, item 5).
    ...(params.headerAccept?.trim() && {
      header_accept: params.headerAccept.trim().slice(0, 1000),
    }),
    // The spec caps user_agent at maxLength 1000; an over-long value would
    // 2.01-fail the whole charge instead of helping it go frictionless.
    ...(params.userAgent?.trim() && {
      user_agent: params.userAgent.trim().slice(0, 1000),
    }),
    ...(params.successUrl && { success_url: params.successUrl }),
    // Recurring 3DS is a full-page redirect. Return both outcomes to the same
    // exact-order reconciliation route; it determines success vs terminal
    // failure from the signed provider state and never trusts the URL alone.
    ...((params.failUrl ?? params.successUrl) && {
      fail_url: params.failUrl ?? params.successUrl,
    }),
    ...(params.metadata && { order_metadata: params.metadata }),
  });
  return settle(client, params.orderId, res, params.amount, params.settlement);
}

/**
 * Starts a NEW subscription on the saved card, with no card re-entry — the
 * add-on OTO. Price/billing period/trial all come from the product, so no
 * amount is sent. Solidgate allows only one active subscription per
 * (customer_account_id, product_id) per channel.
 */
export async function subscribeSavedCard(
  client: SolidgateClient,
  params: {
    orderId: string;
    recurringToken: string;
    /** Derived server-side from the token's original payment method. */
    paymentType: SolidgateRecurringPaymentType;
    productId: string;
    /** Amount due now, not the product's future recurring price. */
    expectedAmount: number;
    /**
     * REQUIRED even though the product carries the price: without it Solidgate
     * bills the product's DEFAULT price, so a USD buyer silently gets charged
     * the EUR one (verified in sandbox). It selects which of the product's
     * per-currency prices applies.
     */
    currency: string;
    orderDescription: string;
    customerAccountId: string;
    customerEmail: string;
    ipAddress: string;
    /** Browser Accept header — 3DS 2.0 browser data for the frictionless flow. */
    headerAccept?: string;
    /** Browser User-Agent — 3DS 2.0 browser data for the frictionless flow. */
    userAgent?: string;
    /** Same-origin funnel/PWA return URL for a possible 3DS redirect. */
    successUrl?: string;
    /** Optional distinct failure return; defaults to the exact-order success route. */
    failUrl?: string;
    metadata?: Record<string, string>;
    /** Route-owned workflows can disable nested status polling. */
    settlement?: { attempts?: number; intervalMs?: number };
  },
): Promise<SolidgateChargeResult> {
  // The add-on subscription uses the same static channel / connector
  // descriptor policy as every other product, including its future renewals.
  const res = await client.recurring<SolidgateOrderResponse>({
    order_id: params.orderId,
    recurring_token: params.recurringToken,
    product_id: params.productId,
    currency: params.currency.toUpperCase(),
    order_description: params.orderDescription,
    type: 'auth',
    settle_interval: 0,
    payment_type: params.paymentType,
    customer_account_id: params.customerAccountId,
    customer_email: params.customerEmail,
    ip_address: params.ipAddress,
    platform: 'WEB',
    // 3DS 2.0 browser data — see chargeSavedCard.
    ...(params.headerAccept?.trim() && {
      header_accept: params.headerAccept.trim().slice(0, 1000),
    }),
    // The spec caps user_agent at maxLength 1000; an over-long value would
    // 2.01-fail the whole charge instead of helping it go frictionless.
    ...(params.userAgent?.trim() && {
      user_agent: params.userAgent.trim().slice(0, 1000),
    }),
    ...(params.successUrl && { success_url: params.successUrl }),
    ...((params.failUrl ?? params.successUrl) && {
      fail_url: params.failUrl ?? params.successUrl,
    }),
    ...(params.metadata && { order_metadata: params.metadata }),
  });
  return settle(client, params.orderId, res, params.expectedAmount, params.settlement);
}
