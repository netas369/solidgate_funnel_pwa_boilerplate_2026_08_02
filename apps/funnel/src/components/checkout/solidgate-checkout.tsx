"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Payment, { SdkLoader } from "@solidgate/react-sdk";
import type { InitConfig, SdkMessage } from "@solidgate/react-sdk";
import type { ProductId } from "@repo/shared/price-map";
import {
  SOLIDGATE_DECLINE_REASONS,
  solidgateDeclineReason,
} from "@repo/shared/solidgate/decline-reason";
import {
  attributionEventProperties,
  readStoredAttribution,
  selectFirstTouchUtm,
} from "@/features/analytics/lib/attribution";
import {
  purchaseEventId,
  type CheckoutProductContext,
} from "@/features/analytics/lib/checkout-context";
import { useQuizStore } from "@/stores/quiz-store";

/**
 * Solidgate checkout — the hosted Payment Form, styled to the paper-ink modal.
 *
 * The form is an iframe on charge-auth.com: it owns the card fields, 3DS, and
 * tokenization, so there is no confirmPayment/Elements plumbing here. We only
 * hand it a server-built, AES-encrypted intent and listen for events.
 */

// Solidgate's white-label CDN (see docs/solidgate/migration-plan.md). Called at
// module scope because SdkLoader dedupes on first call — a later call with a URL
// after a default-URL load is ignored with a console error. SSR-safe: resolves
// to null on the server.
SdkLoader.load("https://cdn.charge-auth.com/js/form.js");

type MerchantData = InitConfig["merchantData"];

interface CreateSessionResponse {
  merchantData: MerchantData;
  orderId: string;
  tracking: CheckoutProductContext;
  error?: string;
  code?: string;
}

interface GrantResponse {
  ok?: boolean;
  pending?: boolean;
  accepted?: boolean;
  authorized?: boolean;
  terminal?: boolean;
  retryable?: boolean;
  orderId?: string;
  error?: string;
  code?: string;
  declineReason?: string;
  resumeTo?: string;
  status?: string;
  subscriptionId?: string;
  captured?: boolean;
  settled?: boolean;
  fullyCaptured?: boolean;
  authorizedTrial?: boolean;
}

const TERMINAL_PAYMENT_STATUSES = new Set(['auth_failed', 'declined', 'void_ok']);

export class TerminalPaymentError extends Error {
  readonly orderId: string;
  readonly providerStatus: string;
  /** Normalized decline family from the grant route, when the gateway gave one. */
  readonly declineReason: string | null;

  constructor(
    orderId: string,
    providerStatus: string,
    code: string,
    declineReason: string | null = null,
  ) {
    super(code);
    this.name = 'TerminalPaymentError';
    this.orderId = orderId;
    this.providerStatus = providerStatus;
    this.declineReason = declineReason;
  }
}

// The auth_ok → settle_ok window is usually a second or two but can stretch to
// tens of seconds under load or on a slow issuer. A server-verified exact paid
// authorization may hand the buyer to OTO1 early, while this exact-order loop
// continues until capture so final access/cookie work still happens promptly.
//
// A DEADLINE, not an attempt count. Every poll costs a browser/server/provider
// round trip, so a fixed attempt count cannot promise a real wall-clock bound.
// The grant route performs one provider read per request; keeping the retry
// cadence in one place avoids the nested waits that caused the original delay.
export const GRANT_POLL_BUDGET_MS = 120_000;
const GRANT_POLL_INTERVAL_MS = 2_000;
const GRANT_REQUEST_TIMEOUT_MS = 15_000;
export const CHECKOUT_OPEN_TIMEOUT_MS = 15_000;
export const SUBMIT_OUTCOME_TIMEOUT_MS = 15_000;

type ConfirmationMode = 'foreground' | 'background' | 'submit-watchdog';

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function confirmSettledGrant(
  orderId: string,
  sessionId: string,
  amountCents: number,
  signal?: AbortSignal,
  onAccepted?: (data: GrantResponse) => boolean | void | Promise<boolean | void>,
): Promise<GrantResponse> {
  const deadline = Date.now() + GRANT_POLL_BUDGET_MS;
  let acceptedNotified = false;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const requestController = new AbortController();
    const relayAbort = () => requestController.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    const requestTimeout = setTimeout(
      () => requestController.abort(),
      Math.min(GRANT_REQUEST_TIMEOUT_MS, remainingMs),
    );
    let res: Response;
    let data: GrantResponse;
    try {
      res = await fetch("/api/solidgate/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body: JSON.stringify({ orderId, sessionId }),
      });
      try {
        data = (await res.json()) as GrantResponse;
      } catch (error) {
        // A timed-out response body is the same ambiguous network outcome as a
        // timed-out fetch: retry this order. Only malformed JSON that arrived
        // within the deadline degrades to the defensive empty response.
        if (requestController.signal.aborted) throw error;
        data = {};
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (Date.now() >= deadline) break;
      await wait(GRANT_POLL_INTERVAL_MS, signal);
      continue;
    } finally {
      clearTimeout(requestTimeout);
      signal?.removeEventListener('abort', relayAbort);
    }
    const captured =
      data.captured === true || data.settled === true || data.fullyCaptured === true;
    const authorizedTrial = amountCents === 0 && data.authorizedTrial === true;
    if (res.ok && data.ok === true && (captured || authorizedTrial)) return data;
    if (
      !acceptedNotified
      && res.status === 202
      && data.pending === true
      && data.accepted === true
      && data.authorized === true
      && data.orderId === orderId
      && data.status === 'auth_ok'
    ) {
      try {
        const ownershipTransferred = await onAccepted?.(data);
        acceptedNotified = true;
        // OTO1 has a refresh-safe exact-order recovery loop. Once its callback
        // has persisted that marker and navigated, it becomes the sole browser
        // owner of reconciliation; returning here prevents two pollers racing
        // the same final account/entitlement grant.
        if (ownershipTransferred === true) return data;
      } catch (error) {
        // A navigation/analytics callback is deliberately outside payment
        // truth. Keep reconciling this exact order; a later captured result
        // still runs the normal success callback on the original page task.
        console.error('[solidgate/checkout] accepted handoff failed:', error);
      }
    }
    if (
      !res.ok &&
      data.terminal === true &&
      data.retryable === true &&
      data.orderId === orderId &&
      typeof data.status === 'string' &&
      TERMINAL_PAYMENT_STATUSES.has(data.status)
    ) {
      throw new TerminalPaymentError(
        orderId,
        data.status,
        data.code ?? data.error ?? 'payment_failed',
        typeof data.declineReason === 'string' ? data.declineReason : null,
      );
    }
    // A 202 is the expected paid auth_ok → settle_ok window. A defensive 200
    // without a final flag is treated the same way, never as a Purchase.
    const pending = res.status === 202
      || res.status === 429
      || res.status >= 500
      || (res.ok && !captured && !authorizedTrial);
    if (!pending) throw new Error(data.code ?? data.error ?? `HTTP ${res.status}`);
    if (Date.now() >= deadline) break;
    await wait(GRANT_POLL_INTERVAL_MS, signal);
  }
  throw new Error('payment_pending');
}

export type SolidgateCheckoutSuccessContext = CheckoutProductContext & {
  subscriptionId?: string;
  subscription_id?: string;
  orderId: string;
  order_id: string;
  solidgate_order_id: string;
  transactionId: string;
  transaction_id: string;
  eventId: string;
  event_id: string;
  $insert_id: string;
  payment_status: string;
  settled: boolean;
  authorized_trial: boolean;
  /** Canonical continuation returned by the server for accepted/final grants. */
  resumeTo?: string;
  attribution: Record<string, string>;
};

/**
 * Every machine code this checkout can put in front of a buyer: our own API
 * codes plus the client-side ones minted in `handleFail`/`onError`. Kept beside
 * the component that renders them so adding a code has an obvious place to add
 * its copy — parents build `errorMessages` from this list, and the i18n
 * deep-key parity test then forces all 15 locales to carry it.
 */
export const CHECKOUT_ERROR_CODES = [
  'EMAIL_REQUIRED',
  'INTRO_OFFER_IN_PROGRESS',
  'INTRO_OFFER_ALREADY_USED',
  'payment_failed',
  'payment_error',
  'checkout_unavailable',
  // Normalized gateway decline families (decline_insufficient_funds, …): the
  // grant route reads them from the status API error and the SDK fail event
  // supplies a fallback, so a declined buyer learns why instead of the generic
  // payment_failed line.
  ...SOLIDGATE_DECLINE_REASONS,
] as const;

export interface SolidgateCheckoutProps {
  productId: ProductId;
  sessionId: string | null;
  /** Formatted price, shown above the form. */
  price: string;
  buttonText: string;
  onSuccess: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
  /**
   * Verified paid authorization. The buyer may enter OTO1 while capture and
   * entitlement provisioning continue on the same order in the background.
   * This callback must never emit a captured Purchase event.
   */
  onAccepted?: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
  locale?: string;
  /** Only fetch the intent once the form is actually visible. */
  intent?: boolean;
  renewalNote?: string;
  utm?: Record<string, string>;
  /** Caption under the orbit loader while the hosted form loads. */
  loadingLabel?: string;
  /** Short heading shown immediately after the buyer submits payment. */
  processingLabel?: string;
  /** Lets the modal prevent accidental dismissal while payment is in flight. */
  onProcessingChange?: (processing: boolean) => void;
  /**
   * Human message shown when the grant poll gives up while Solidgate is still
   * settling ('payment_pending'). The card may already be charged — the raw
   * code would read like a decline and push the buyer into paying twice.
   */
  pendingNotice?: string;
  /**
   * Localized copy keyed by the machine codes this checkout can surface — ours
   * (INTRO_OFFER_IN_PROGRESS, INTRO_OFFER_ALREADY_USED, EMAIL_REQUIRED …) and
   * Solidgate's decline codes. Without it the buyer reads the enum: production
   * showed real Czech buyers a red `INTRO_OFFER_IN_PROGRESS` where the card
   * form should have been.
   */
  errorMessages?: Record<string, string>;
  /** Shown for any code not in `errorMessages`. */
  genericError?: string;
  /**
   * Caption shown while the server confirms a submitted payment. That wait can
   * legitimately run to GRANT_POLL_BUDGET_MS, and until now the only sign of it
   * was the form dimming to 0.6 opacity — buyers read a silent, frozen form as
   * a broken payment and try again on another card.
   */
  grantingNotice?: string;
}

// ── Styling ────────────────────────────────────────────────────────────────
// The checkout modal renders inside .lmRoot: white paper, near-black ink,
// square corners, hairline borders (landing.css). next/font variables are
// scoped to the parent document and cannot cross into the cross-origin iframe,
// so the form pulls its own webfont via formParams.googleFontLink.

const PAPER = "#ffffff";
const INK = "#111111";
const INK_SOFT = "#1a1a1a";
const HAIRLINE_STRONG = "rgba(0,0,0,0.18)";
const ERROR = "#ba1a1a";
const SANS = "'Inter', system-ui, -apple-system, sans-serif";

const INPUT = {
  "background-color": PAPER,
  color: INK,
  border: `1px solid ${HAIRLINE_STRONG}`,
  "border-radius": "0px",
  padding: "13px 14px",
  "font-size": "15px",
  "line-height": "1.4",
  "font-family": SANS,
  height: "48px",
} as const;

const INPUT_STATES = {
  ":focus": { "border-color": INK, outline: "none", "box-shadow": "none" },
  "::placeholder": { color: "rgba(17,17,17,0.38)" },
} as const;

// Field keys (card_number, expiry_date, …) style the WRAPPER that also holds
// the label — bare CSS there draws a second box around label+input and the
// 48px input overflows it. Target the children instead.
const FIELD = {
  input: { ...INPUT, ...INPUT_STATES },
  ".label": {
    color: INK_SOFT,
    "font-size": "10px",
    "font-weight": "600",
    "text-transform": "uppercase",
    "letter-spacing": "0.18em",
    "margin-bottom": "6px",
  },
  ".error input": { "border-color": ERROR },
  ".error .label": { color: ERROR },
} as const;

const FORM_STYLES: Record<string, unknown> = {
  form_body: {
    "background-color": PAPER,
    "font-family": SANS,
    color: INK_SOFT,
    "font-weight": "500",
  },
  input_group: { margin: "0 0 14px 0" },
  card_number: FIELD,
  expiry_date: FIELD,
  card_cvv: FIELD,
  card_holder: FIELD,
  submit_button: {
    "background-color": INK,
    color: PAPER,
    border: `1px solid ${INK}`,
    "border-radius": "0px",
    width: "100%",
    padding: "16px 18px",
    "font-size": "15px",
    "letter-spacing": "0.06em",
    "font-weight": "500",
    "font-family": SANS,
    cursor: "pointer",
    ":hover": { "background-color": "#0a0a0a" },
    ":disabled": { "background-color": HAIRLINE_STRONG, cursor: "not-allowed" },
  },
  body_errors: {
    color: ERROR,
    "font-size": "13px",
    "text-align": "center",
    "margin-top": "8px",
  },
};

const GOOGLE_FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap";

// ── Orbit loader ───────────────────────────────────────────────────────────
// Shown while the order is minted and the hosted form iframe boots, so the
// form fades in instead of popping out of nowhere. Ink planets on hairline
// orbits — a lightweight CSS-only loader, no image assets.

const ORBITS = [
  { size: 116, duration: 7.5, dot: 7, opacity: 1, reverse: false },
  { size: 82, duration: 5, dot: 5, opacity: 0.65, reverse: true },
  { size: 48, duration: 3.2, dot: 4, opacity: 0.45, reverse: false },
];

function OrbitLoader({
  label,
  description,
  overlay = false,
}: {
  label?: string;
  description?: string;
  overlay?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: overlay ? 2 : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: overlay ? 18 : 22,
        minHeight: overlay ? 280 : undefined,
        padding: overlay ? "28px 20px" : undefined,
        background: overlay ? "rgba(255,255,255,0.98)" : undefined,
        textAlign: "center",
      }}
    >
      <style>{`
        @keyframes sg-orbit { to { transform: rotate(360deg); } }
        @keyframes sg-orbit-r { to { transform: rotate(-360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .sg-orbit-ring { animation: none !important; }
        }
      `}</style>
      <div aria-hidden style={{ position: "relative", width: 120, height: 120 }}>
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: 8,
            height: 8,
            margin: "-4px 0 0 -4px",
            background: INK,
            borderRadius: "50%",
          }}
        />
        {ORBITS.map((o) => (
          <div
            key={o.size}
            className="sg-orbit-ring"
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: o.size,
              height: o.size,
              margin: `${-o.size / 2}px 0 0 ${-o.size / 2}px`,
              border: "1px solid rgba(17,17,17,0.12)",
              borderRadius: "50%",
              animation: `${o.reverse ? "sg-orbit-r" : "sg-orbit"} ${o.duration}s linear infinite`,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -o.dot / 2,
                left: "50%",
                marginLeft: -o.dot / 2,
                width: o.dot,
                height: o.dot,
                borderRadius: "50%",
                background: INK,
                opacity: o.opacity,
              }}
            />
          </div>
        ))}
      </div>
      {label ? (
        <span
          style={{
            fontSize: overlay ? 12 : 10,
            letterSpacing: overlay ? "0.2em" : "0.28em",
            textTransform: "uppercase",
            color: INK,
            opacity: overlay ? 0.8 : 0.55,
            fontFamily: SANS,
            fontWeight: overlay ? 600 : 400,
          }}
        >
          {label}
        </span>
      ) : null}
      {description ? (
        <span
          style={{
            maxWidth: 340,
            color: INK,
            opacity: 0.62,
            fontFamily: SANS,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}

export function SolidgateCheckout({
  productId,
  sessionId,
  price,
  buttonText,
  onSuccess,
  onAccepted,
  locale,
  intent = false,
  renewalNote,
  utm,
  loadingLabel,
  processingLabel,
  onProcessingChange,
  pendingNotice,
  errorMessages,
  genericError,
  grantingNotice,
}: SolidgateCheckoutProps) {
  const [merchantData, setMerchantData] = useState<MerchantData | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [tracking, setTracking] = useState<CheckoutProductContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  // Starts at the SDK's validated submit event, before success/fail arrives.
  // This closes the otherwise silent provider-processing gap without covering
  // an interactive 3DS challenge (onVerify clears it again).
  const [submittedProcessing, setSubmittedProcessing] = useState(false);
  // Once a submitted order becomes ambiguous, the hosted iframe is inert. It
  // can only be replaced after this same order is verified terminal and the
  // server returns a different order id.
  const [confirmationBlocked, setConfirmationBlocked] = useState(false);
  // The iframe reports `mounted` once it has rendered its fields; until then
  // we keep the orbit loader up and the (already-mounting) form invisible.
  const [formReady, setFormReady] = useState(false);
  const requested = useRef(false);
  // Set once the buyer actually submits the form. An `error` before this is a
  // pre-charge form/SDK problem (retry), not a charged order to recover.
  const submitted = useRef(false);
  // Order id currently being confirmed, or null. Guards confirmAndForward
  // against the SDK firing `success` and `error` for the same order.
  const confirmingOrder = useRef<string | null>(null);
  const acceptedOrder = useRef<string | null>(null);
  // Normalized decline family from the SDK `fail` event. Only a fallback: the
  // grant route's status-API reason wins, this covers the webhook-raced path
  // where the server never saw the gateway error object.
  const lastFailReason = useRef<string | null>(null);
  const paymentInFlight = !error && (submittedProcessing || granting);

  useEffect(() => {
    onProcessingChange?.(paymentInFlight);
  }, [onProcessingChange, paymentInFlight]);

  useEffect(
    () => () => onProcessingChange?.(false),
    [onProcessingChange],
  );

  const openOrder = useCallback(async (terminalOrderId?: string) => {
    const attribution = readStoredAttribution();
    const requestOrder = async (): Promise<{ res: Response; data: CreateSessionResponse }> => {
      const requestController = new AbortController();
      const requestTimeout = setTimeout(
        () => requestController.abort(),
        CHECKOUT_OPEN_TIMEOUT_MS,
      );
      try {
        const res = await fetch("/api/solidgate/create-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: requestController.signal,
          // Full first/last-touch attribution is available to downstream analytics;
          // the route selects the five first-touch UTMs for Solidgate's 10-key cap.
          body: JSON.stringify({
            productId,
            sessionId,
            utm: utm ?? selectFirstTouchUtm(attribution),
            attribution,
          }),
        });
        // Keep the same deadline armed while the body is read. A proxy can send
        // headers and then stall forever; clearing after fetch() would recreate
        // the blank-loader failure even though the response technically arrived.
        const data = (await res.json()) as CreateSessionResponse;
        return { res, data };
      } catch (cause) {
        if (requestController.signal.aborted) {
          throw new Error("checkout_unavailable", { cause });
        }
        throw cause;
      } finally {
        clearTimeout(requestTimeout);
      }
    };

    let { res, data } = await requestOrder();
    if (res.status === 404 && sessionId) {
      // The sessions row can be missing even though the buyer legitimately got
      // here: if the persist that creates it was lost (network drop, dying
      // browser), later snapshots never recreated it. Payment must not
      // dead-end on that — restore the minimal identity from client state and
      // retry once. Best-effort: a failed restore just resurfaces the 404.
      const answers = useQuizStore.getState().answers as Record<string, unknown>;
      const storedEmail = [answers["userEmail"], answers["email"]]
        .find((v): v is string => typeof v === "string" && v.includes("@"));
      const effectiveLocale = locale
        || (typeof document !== "undefined" ? document.documentElement.lang : "");
      if (effectiveLocale) {
        await fetch("/api/session/persist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            locale: effectiveLocale,
            ...(storedEmail ? { email: storedEmail } : {}),
          }),
        }).catch(() => {});
        ({ res, data } = await requestOrder());
      }
    }
    if (!res.ok) throw new Error(data.code ?? data.error ?? `HTTP ${res.status}`);
    if (terminalOrderId && data.orderId === terminalOrderId) {
      // create-session has not observed the verified terminal transition yet.
      // Keep the burnt form blocked; mounting it again would resubmit the same
      // Solidgate idempotency key.
      throw new Error('payment_pending');
    }
    // A fresh order is a fresh confirmation cycle, whatever the previous one did.
    confirmingOrder.current = null;
    acceptedOrder.current = null;
    submitted.current = false;
    lastFailReason.current = null;
    setSubmittedProcessing(false);
    setFormReady(false);
    setConfirmationBlocked(false);
    setMerchantData(data.merchantData);
    setOrderId(data.orderId);
    setTracking(data.tracking);
  }, [productId, sessionId, utm, locale]);

  useEffect(() => {
    if (!intent || !sessionId || requested.current) return;
    requested.current = true;
    // openOrder only updates state after its first await (the fetch response).
    openOrder().catch((e: unknown) => {
      requested.current = false;
      setError(e instanceof Error ? e.message : "checkout_unavailable");
    });
  }, [intent, sessionId, openOrder]);

  // The form's success event is a client-side claim. Money is only recognised
  // after the server re-reads the order from Solidgate's status API. Both the
  // success event and a post-submit `error` route through here: once the card
  // has left the buyer's hands the order may already be charged, so we confirm
  // against the real status instead of trusting either client event.
  const confirmAndForward = useCallback(
    async (
      subscriptionIdHint?: string | null,
      mode: ConfirmationMode = 'foreground',
    ) => {
      if (!orderId || !sessionId || !tracking) return;
      // Both `success` and a post-submit `error` route here, and the SDK can
      // fire both for one order — production logs showed 11 grant polls in 35s
      // where one loop can manage at most ~4, i.e. two or three loops racing.
      // Key the latch on the ORDER, not a bare boolean: handleFail mints a new
      // order while a stale poll may still be running, and a boolean latch would
      // swallow the retry card's success and strand a charged buyer.
      if (confirmingOrder.current === orderId) return;
      confirmingOrder.current = orderId;
      if (mode === 'foreground') {
        setError(null);
        setSubmittedProcessing(false);
        setGranting(true);
        setConfirmationBlocked(true);
      } else if (mode === 'background') {
        // A durable pending notice is already visible. Recheck the exact order
        // without replacing that calm state with another two-minute overlay.
        setSubmittedProcessing(false);
        setGranting(false);
        setConfirmationBlocked(true);
      }
      // submit-watchdog deliberately preserves the existing submit overlay but
      // does not set confirmationBlocked. If a late 3DS verify event arrives,
      // it can still reveal an interactive issuer challenge while this exact
      // order continues reconciling in the background.
      const checkoutContext = (
        data: GrantResponse,
        subscriptionId?: string,
      ): SolidgateCheckoutSuccessContext => {
        const eventId = purchaseEventId(orderId);
        const captured =
          data.captured === true || data.settled === true || data.fullyCaptured === true;
        return {
          ...tracking,
          orderId,
          order_id: orderId,
          solidgate_order_id: orderId,
          transactionId: orderId,
          transaction_id: orderId,
          eventId,
          event_id: eventId,
          $insert_id: eventId,
          payment_status: data.status ?? 'unknown',
          settled: captured,
          authorized_trial: tracking.amount_cents === 0 && data.authorizedTrial === true,
          resumeTo: data.resumeTo,
          attribution: attributionEventProperties(),
          subscriptionId,
          subscription_id: subscriptionId,
        };
      };
      try {
        const data = await confirmSettledGrant(
          orderId,
          sessionId,
          tracking.amount_cents,
          undefined,
          async (accepted) => {
            if (!onAccepted || acceptedOrder.current === orderId) return;
            const acceptedSubscriptionId = accepted.subscriptionId
              ?? subscriptionIdHint
              ?? undefined;
            await onAccepted(checkoutContext(accepted, acceptedSubscriptionId));
            acceptedOrder.current = orderId;
            return true;
          },
        );
        const captured =
          data.captured === true || data.settled === true || data.fullyCaptured === true;
        if (data.accepted === true && !captured) return;
        const subscriptionId = data.subscriptionId ?? subscriptionIdHint ?? undefined;
        await onSuccess(checkoutContext(data, subscriptionId));
      } catch (e: unknown) {
        if (e instanceof TerminalPaymentError && e.orderId === orderId) {
          setSubmittedProcessing(false);
          if (acceptedOrder.current === orderId) {
            // The buyer already left this mounted form on a server-verified
            // authorization. Never mint a silent N+1 checkout behind OTO1;
            // the durable lifecycle now owns any later void/decline.
            console.error('[solidgate/checkout] accepted payment became terminal', {
              orderId,
              status: e.providerStatus,
            });
            return;
          }
          // The server has persisted an explicit terminal provider status. Only
          // now may create-session allocate N+1; assert it returns a different
          // id before replacing the iframe. Prefer the server-read decline
          // family, then the SDK fail event's, before the generic line.
          setError(e.declineReason ?? lastFailReason.current ?? 'payment_failed');
          setGranting(false);
          try {
            await openOrder(orderId);
          } catch {
            confirmingOrder.current = orderId;
            setConfirmationBlocked(true);
            setError('payment_pending');
          }
          return;
        }

        // Pending, timeout, network ambiguity, or an unverifiable server error:
        // retain both the same-order latch and the inert form. A later recheck
        // may query this order again, but no code path can mint another charge.
        confirmingOrder.current = orderId;
        setSubmittedProcessing(false);
        setGranting(false);
        setConfirmationBlocked(true);
        setError(e instanceof Error ? e.message : "payment_pending");
      }
    },
    [orderId, sessionId, tracking, onSuccess, onAccepted, openOrder],
  );

  /**
   * SDK `fail` is only a browser claim. Reconcile the SAME order server-side;
   * confirmAndForward opens N+1 only after an explicit terminal response.
   */
  const handleFail = useCallback(
    (event: SdkMessage["fail"]) => {
      if (event.message ?? event.code) {
        console.warn("[solidgate/checkout] declined", {
          code: event.code,
          message: event.message,
        });
      }
      lastFailReason.current = solidgateDeclineReason(event.code);
      void confirmAndForward();
    },
    [confirmAndForward],
  );

  // The pending notice is durable, but keep re-reading the same provider order
  // in the background. This is deliberately unable to call openOrder: only a
  // TerminalPaymentError inside confirmAndForward can cross that boundary.
  useEffect(() => {
    if (error !== 'payment_pending' || !confirmationBlocked || !orderId) return;
    const timer = window.setTimeout(() => {
      if (confirmingOrder.current !== orderId) return;
      confirmingOrder.current = null;
      void confirmAndForward(undefined, 'background');
    }, GRANT_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [error, confirmationBlocked, orderId, confirmAndForward]);

  // Solidgate normally follows submit with success/fail/error/verify within a
  // few seconds. If that postMessage is lost, begin server-side reconciliation
  // for this exact order instead of leaving the buyer behind an endless loader.
  useEffect(() => {
    if (!submittedProcessing || !orderId) return;
    const timer = window.setTimeout(() => {
      if (!submitted.current || confirmingOrder.current === orderId) return;
      void confirmAndForward(undefined, 'submit-watchdog');
    }, SUBMIT_OUTCOME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [submittedProcessing, orderId, confirmAndForward]);

  const handleSuccess = useCallback(
    (event: SdkMessage["success"]) => confirmAndForward(event.order?.subscription_id),
    [confirmAndForward],
  );

  const formParams = useMemo(
    () => ({
      enabled: true,
      submitButtonText: buttonText,
      googleFontLink: GOOGLE_FONT_LINK,
      isCardHolderVisible: false,
      // Solidgate renders its own errors inside the iframe; keep our chrome quiet.
      headerText: "",
      titleText: "",
    }),
    [buttonText],
  );

  const processingOverlayVisible =
    !error && (submittedProcessing || (granting && confirmationBlocked));
  const formBlocked = confirmationBlocked || submittedProcessing;

  return (
    <div className="space-y-4">
      <p className="text-center text-sm font-semibold text-si-on-surface-variant">{price}</p>

      <div style={{ position: "relative", minHeight: formReady ? 0 : 280 }}>
        {merchantData && (
          <div
            aria-busy={formBlocked}
            inert={formBlocked ? true : undefined}
            style={{
              opacity: formReady ? (formBlocked ? 0.6 : 1) : 0,
              transition: "opacity 400ms ease",
              pointerEvents: formBlocked ? 'none' : 'auto',
            }}
          >
            <Payment
              // Remount on a fresh order: a burnt order_id can never be retried.
              key={orderId ?? "pending"}
              merchantData={merchantData}
              styles={FORM_STYLES}
              formParams={formParams}
              // Support approved token-based OTO reuse: card/network tokens use
              // 1-click while Apple Pay tokens use rebill. JS integration also
              // exposes Apple's QR flow outside Safari.
              applePayButtonParams={{ enabled: true, integrationType: 'js' }}
              // Google Pay stays off until its Console merchant/domain setup is
              // complete and google_pay_merchant_id can be bound in the intent.
              googlePayButtonParams={{ enabled: false }}
              paypalButtonParams={{ enabled: false }}
              pixButtonParams={{ enabled: false }}
              upiButtonParams={{ enabled: false }}
              pixQrButtonParams={{ enabled: false }}
              bizumButtonParams={{ enabled: false }}
              blikButtonParams={{ enabled: false }}
              mbwayButtonParams={{ enabled: false }}
              cashAppButtonParams={{ enabled: false }}
              pixAutomaticoButtonParams={{ enabled: false }}
              clickToPayButtonParams={{ enabled: false }}
              width="100%"
              onMounted={() => setFormReady(true)}
              onSubmit={() => {
                submitted.current = true;
                lastFailReason.current = null;
                setError(null);
                setSubmittedProcessing(true);
              }}
              onSuccess={handleSuccess}
              onFail={handleFail}
              // `error` (unlike `fail`) can fire AFTER a 3DS challenge on an
              // order that actually settled — showing a raw "payment_error"
              // then would tell a charged buyer their payment failed. Once the
              // buyer has submitted, confirm against the real order status: a
              // paid order forwards them, a genuinely failed one surfaces the
              // decline from the grant route. A pre-submit error is just a form
              // problem to retry.
              onError={() => {
                if (submitted.current) {
                  void confirmAndForward();
                  return;
                }
                setSubmittedProcessing(false);
                setError("payment_error");
              }}
              // 3DS runs inside the form (verify → formRedirect); nothing to do
              // here but keep the UI honest while the issuer decides. The
              // challenge must remain visible and interactive, so remove the
              // post-submit overlay until success/fail resumes reconciliation.
              onVerify={() => {
                setSubmittedProcessing(false);
                setGranting(true);
              }}
            />
          </div>
        )}
        {/* Loader until the form is mounted; a terminal create-session error
            (merchantData never arrives) shows the error line alone instead of
            an endless spinner. */}
        {(merchantData ? !formReady : !error) && <OrbitLoader label={loadingLabel} />}
        {processingOverlayVisible && (
          <OrbitLoader
            overlay
            label={processingLabel ?? grantingNotice}
            description={processingLabel ? grantingNotice : undefined}
          />
        )}
      </div>

      {/* Keep a single live announcement. During 3DS the opaque overlay is
          removed and this notice remains below the interactive issuer form. */}
      {granting && !processingOverlayVisible && !error && grantingNotice && (
        <p className="text-center text-sm text-si-on-surface-variant">
          {grantingNotice}
        </p>
      )}

      {error &&
        (error === "payment_pending" && pendingNotice ? (
          // Not a decline: Solidgate is still settling and the card may already
          // be charged. Calm notice instead of an error line.
          <p className="text-center text-sm text-si-on-surface-variant" role="status">
            {pendingNotice}
          </p>
        ) : (
          <p className="text-center text-sm text-si-error" role="alert">
            {/* Never render a raw code at a buyer. Falling all the way through
                to `error` only happens when neither map nor fallback is wired
                up, which the parent should treat as a bug. */}
            {errorMessages?.[error] ?? genericError ?? error}
          </p>
        ))}

      {renewalNote && (
        <p className="text-center text-xs text-si-on-surface-variant" style={{ opacity: 0.72 }}>
          {renewalNote}
        </p>
      )}

      {locale ? null : null}
    </div>
  );
}

export default SolidgateCheckout;
