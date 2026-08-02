import type { InitConfig } from "@solidgate/react-sdk";
import { captureConfirmedPurchase } from "@/lib/analytics/posthog";
import type { ConfirmedPurchase } from "@/lib/analytics/payment-event";

/**
 * Member-area purchase client: talks to /api/solidgate/purchase and hides which
 * of the two paths ran.
 *
 *   saved card → one click, no UI beyond the button
 *   no card    → the caller mounts the hosted form with `merchantData`
 *
 * Both end at purchase/confirm, which is the only thing that grants anything.
 */

export type MerchantData = InitConfig["merchantData"];

export type PurchaseOutcome =
  | { kind: "granted"; payment?: ConfirmedPurchase }
  | { kind: "already_owned" }
  /** Mount the form: we hold no card for this buyer (or theirs just died). */
  | { kind: "needs_card"; merchantData: MerchantData; orderId: string }
  /** 3DS on a saved card is a redirect, not a modal. */
  | { kind: "redirect"; verifyUrl: string; orderId: string }
  /** The request outcome is uncertain. Preserve the provider identity when known. */
  | { kind: "pending"; orderId?: string }
  | {
      kind: "failed";
      error: string;
      code?: string;
      /** Solidgate's terminal order status, when the server supplied one. */
      status?: string;
      /** Lets callers distinguish a proven terminal card result from other failures. */
      httpStatus?: number;
      orderId?: string;
    };

interface PurchaseResponse {
  ok?: boolean;
  alreadyOwned?: boolean;
  needsCard?: boolean;
  needsNewCard?: boolean;
  pending?: boolean;
  requiresAction?: boolean;
  confirmRequired?: boolean;
  verifyUrl?: string;
  merchantData?: MerchantData;
  orderId?: string;
  error?: string;
  code?: string;
  status?: string;
  terminal?: boolean;
  payment?: ConfirmedPurchase;
}

/** Includes response-body parsing; a timeout may still hide an accepted charge. */
export const PWA_PAYMENT_REQUEST_TIMEOUT_MS = 15_000;
/** One shared wall-clock budget for the complete post-3DS recovery loop. */
export const PWA_REDIRECT_CONFIRM_TIMEOUT_MS = 15_000;

/** Which server endpoints a start/confirm pair talks to. */
export type CheckoutEndpoints = { start: string; confirm: string };
const PURCHASE_ENDPOINTS: CheckoutEndpoints = {
  start: "/api/solidgate/purchase",
  confirm: "/api/solidgate/purchase/confirm",
};

async function postPurchase(
  path: string,
  body: Record<string, unknown>,
  requestTimeoutMs = PWA_PAYMENT_REQUEST_TIMEOUT_MS,
): Promise<{ res: Response; data: PurchaseResponse | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Payment request timed out", "TimeoutError")),
    Math.max(1, Math.min(PWA_PAYMENT_REQUEST_TIMEOUT_MS, requestTimeoutMs)),
  );
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    let data: PurchaseResponse | null;
    try {
      const parsed = await res.json() as unknown;
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as PurchaseResponse
        : null;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      data = null;
    }
    return { res, data };
  } finally {
    clearTimeout(timeout);
  }
}

function responseOrderId(data: PurchaseResponse | null): string | undefined {
  return typeof data?.orderId === "string" && data.orderId.length > 0
    ? data.orderId
    : undefined;
}

function pendingOutcome(orderId?: string): PurchaseOutcome {
  return orderId ? { kind: "pending", orderId } : { kind: "pending" };
}

function retryableConfirmationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function failedOutcome(
  res: Response,
  data: PurchaseResponse,
  fallbackOrderId?: string,
): PurchaseOutcome {
  // Confirmation callers already possess the canonical identity. Prefer that
  // trusted input over anything echoed by an error response.
  const orderId = fallbackOrderId ?? responseOrderId(data);
  return {
    kind: "failed",
    error: data.error ?? "Payment failed",
    ...(data.code && { code: data.code }),
    ...(data.status && { status: data.status }),
    httpStatus: res.status,
    ...(orderId ? { orderId } : {}),
  };
}

export async function startPurchase(
  params: {
    slug: string;
    locale: string;
    /** Skip the saved card and collect a fresh one on the hosted form. */
    forceForm?: boolean;
  },
  endpoints: CheckoutEndpoints = PURCHASE_ENDPOINTS,
): Promise<PurchaseOutcome> {
  let initial: Awaited<ReturnType<typeof postPurchase>>;
  try {
    initial = await postPurchase(endpoints.start, params);
  } catch {
    return pendingOutcome();
  }
  const { res, data } = initial;

  // A response that cannot be parsed is indistinguishable from losing the
  // response body after the server accepted the request. The atomic opener can
  // safely resolve it on a later retry.
  if (!data) return pendingOutcome();

  if (res.ok && data.alreadyOwned) return { kind: "already_owned" };

  // One-click charge went through: nothing is granted until the server re-reads
  // the order, so confirm before telling the buyer anything.
  if (res.ok && data.ok && data.orderId) {
    return confirmPurchase(data.orderId, { endpoints });
  }

  if (data.requiresAction && data.verifyUrl && data.orderId) {
    return { kind: "redirect", verifyUrl: data.verifyUrl, orderId: data.orderId };
  }
  if (res.status === 202) return pendingOutcome(responseOrderId(data));

  // No card was ever submitted: this form may be mounted immediately.
  if (data.needsCard) {
    if (data.merchantData && data.orderId) {
      return { kind: "needs_card", merchantData: data.merchantData, orderId: data.orderId };
    }
  }

  if (res.status === 402 && data.needsNewCard) {
    const terminalOrderId = responseOrderId(data);
    const terminalFailure = failedOutcome(res, data, terminalOrderId);
    // A dead saved card may advance only through the atomic opener. Re-entering
    // an already submitted hosted form with the terminal order id is unsafe, so
    // accept the replacement only when the server proves it is N+1.
    if (params.forceForm || !terminalOrderId) return terminalFailure;

    let retryResult: Awaited<ReturnType<typeof postPurchase>>;
    try {
      retryResult = await postPurchase(endpoints.start, {
        ...params,
        forceForm: true,
      });
    } catch {
      return terminalFailure;
    }
    const retryData = retryResult.data;
    if (
      retryResult.res.ok &&
      retryData?.needsCard &&
      retryData.merchantData &&
      retryData.orderId &&
      retryData.orderId !== terminalOrderId
    ) {
      return { kind: "needs_card", merchantData: retryData.merchantData, orderId: retryData.orderId };
    }
    if (retryResult.res.ok && retryData?.alreadyOwned) return { kind: "already_owned" };
    return terminalFailure;
  }

  return failedOutcome(res, data);
}

export async function confirmPurchase(
  orderId: string,
  options: { timeoutMs?: number; endpoints?: CheckoutEndpoints } = {},
): Promise<PurchaseOutcome> {
  const endpoints = options.endpoints ?? PURCHASE_ENDPOINTS;
  let confirmation: Awaited<ReturnType<typeof postPurchase>>;
  try {
    confirmation = await postPurchase(
      endpoints.confirm,
      { orderId },
      options.timeoutMs,
    );
  } catch {
    return pendingOutcome(orderId);
  }
  const { res, data } = confirmation;

  // Never substitute an identity from an ambiguous response. The input order
  // is the one the caller already submitted and the only safe object to poll.
  if (!data || res.status === 202) return pendingOutcome(orderId);
  const returnedOrderId = responseOrderId(data);
  if (returnedOrderId && returnedOrderId !== orderId) return pendingOutcome(orderId);
  if (res.ok && data.ok) {
    if (
      (data.payment?.order_id && data.payment.order_id !== orderId)
    ) {
      return pendingOutcome(orderId);
    }
    if (data.payment) void captureConfirmedPurchase(data.payment);
    return { kind: "granted", payment: data.payment };
  }

  // A parsed body does not make a timeout, throttling response, or server
  // failure authoritative. Likewise, application/auth/binding errors are not
  // proof that Solidgate terminally rejected this exact card order. Preserve
  // the caller's canonical order identity so bounded return recovery can poll
  // it again; only the confirm route's explicit terminal decision is consumed.
  if (retryableConfirmationStatus(res.status) || data.terminal !== true) {
    return pendingOutcome(orderId);
  }
  return failedOutcome(res, data, orderId);
}

/**
 * A 3DS return can arrive a fraction before the settle webhook/order status.
 * Retry only the server-side confirmation; every attempt re-reads Solidgate
 * and therefore cannot grant from a forged query parameter.
 */
export async function confirmPurchaseAfterRedirect(
  orderId: string,
  options: {
    attempts?: number;
    intervalMs?: number;
    timeoutMs?: number;
    endpoints?: CheckoutEndpoints;
  } = {},
): Promise<PurchaseOutcome> {
  const attempts = Math.max(1, options.attempts ?? 12);
  const intervalMs = Math.max(0, options.intervalMs ?? 750);
  const timeoutMs = Math.max(
    1,
    Math.min(PWA_REDIRECT_CONFIRM_TIMEOUT_MS, options.timeoutMs ?? PWA_REDIRECT_CONFIRM_TIMEOUT_MS),
  );
  const deadline = Date.now() + timeoutMs;
  let outcome: PurchaseOutcome = pendingOutcome(orderId);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return outcome;

    outcome = await confirmPurchase(orderId, {
      timeoutMs: remainingMs,
      endpoints: options.endpoints,
    });
    if (outcome.kind !== "pending") return outcome;
    if (attempt < attempts - 1) {
      const remainingAfterRequestMs = deadline - Date.now();
      if (remainingAfterRequestMs <= 0) return outcome;
      await new Promise((resolve) => setTimeout(
        resolve,
        Math.min(intervalMs, remainingAfterRequestMs),
      ));
    }
  }
  return outcome;
}
