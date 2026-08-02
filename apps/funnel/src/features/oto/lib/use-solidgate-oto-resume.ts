'use client';

import { useEffect, useRef } from 'react';
import {
  clearSolidgateConfirmOrigin,
  isCurrentSolidgateConfirmOrigin,
  readSolidgateConfirmOrigin,
  resumeSolidgateOto,
} from './charge-oto';
import type { OtoChargeOutcome, SolidgateConfirmOrigin } from './charge-oto';
import { useAcceptedOtoRecovery } from './use-accepted-oto-recovery';

function otoStepFromProduct(productSlug: string | undefined): string | null {
  return productSlug?.match(/^oto([1-7])_/)?.[1] ?? null;
}

/** Low-cadence reconciliation for an exact order that is still processing. */
export const OTO_RESUME_RETRY_MS = 15_000;
/** Five minutes of automatic recovery; refresh can safely resume the same marker. */
export const OTO_RESUME_MAX_AUTO_RETRIES = 20;

/**
 * Finishes an OTO that went through a 3DS redirect.
 *
 * A token charge cannot do 3DS inline, so the buyer leaves for the issuer's ACS
 * page and Solidgate returns them here with ?sg_confirm=<orderId>. This picks
 * that up, has the server re-read the order from Solidgate, and then runs the
 * page's normal success path (track + advance to the next OTO).
 *
 * The marker remains owned by its exact history entry until a definitive
 * result. Navigating away aborts without copying it to the next OTO; Back can
 * therefore retry the same server-bound order safely.
 */
export function useSolidgateOtoResume(params: {
  slug: string;
  sessionId: string | null;
  /** Receives the settled charge so the page can report the same analytics as an inline success. */
  onSuccess: (charged: OtoChargeOutcome) => void;
  /** Accepted but not captured: advance without emitting purchase analytics. */
  onAccepted?: (charged: OtoChargeOutcome) => void;
  /**
   * Fired once when the order is confirmed still-settling — show the calm
   * payment-pending notice, not an error. The card may already be charged.
   */
  onPending?: () => void;
  onError?: (message: string) => void;
}): void {
  const { slug, sessionId, onSuccess, onAccepted, onPending, onError } = params;
  useAcceptedOtoRecovery(sessionId);
  const callbacksRef = useRef({ onSuccess, onAccepted, onPending, onError });
  useEffect(() => {
    callbacksRef.current = { onSuccess, onAccepted, onPending, onError };
  }, [onSuccess, onAccepted, onPending, onError]);
  const resumeOriginRef = useRef<SolidgateConfirmOrigin | null>(null);
  const activeOrderRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    if (
      resumeOriginRef.current
      && !isCurrentSolidgateConfirmOrigin(resumeOriginRef.current)
    ) {
      resumeOriginRef.current = null;
    }
    const origin = resumeOriginRef.current ?? readSolidgateConfirmOrigin();
    if (!origin) return;
    resumeOriginRef.current = origin;
    const orderId = origin.orderId;
    if (activeOrderRef.current === orderId) return;
    activeOrderRef.current = orderId;
    let active = true;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;

    const scheduleRetry = () => {
      if (
        !active
        || !isCurrentSolidgateConfirmOrigin(origin)
        || retryTimer !== null
        || retryCount >= OTO_RESUME_MAX_AUTO_RETRIES
      ) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryCount += 1;
        runAttempt();
      }, OTO_RESUME_RETRY_MS);
    };

    const runAttempt = () => {
      if (!active || !isCurrentSolidgateConfirmOrigin(origin)) return;
      controller = new AbortController();
      void resumeSolidgateOto({
        slug,
        sessionId,
        orderId,
        signal: controller.signal,
      })
        .then((outcome) => {
          if (!active || !isCurrentSolidgateConfirmOrigin(origin)) return;

          if (outcome.redirecting && outcome.verifyUrl) {
            window.location.assign(outcome.verifyUrl);
            return;
          }

          const requestedStep = otoStepFromProduct(slug);
          const resolvedStep = otoStepFromProduct(outcome.productSlug);
          if (resolvedStep && requestedStep !== resolvedStep) {
            clearSolidgateConfirmOrigin(origin);
            resumeOriginRef.current = null;
            activeOrderRef.current = null;
            callbacksRef.current.onError?.('binding_mismatch');
            return;
          }

          if (outcome.ok || outcome.accepted) {
            if (!clearSolidgateConfirmOrigin(origin)) return;
            resumeOriginRef.current = null;
            activeOrderRef.current = null;
            if (outcome.ok) callbacksRef.current.onSuccess(outcome);
            else callbacksRef.current.onAccepted?.(outcome);
            return;
          }

          if (outcome.pending) {
            // The marker stays on its original history entry. Reconcile this
            // exact order at low cadence until accepted or terminal.
            callbacksRef.current.onPending?.();
            callbacksRef.current.onError?.('payment_pending');
            scheduleRetry();
            return;
          }

          if (!clearSolidgateConfirmOrigin(origin)) return;
          resumeOriginRef.current = null;
          activeOrderRef.current = null;
          callbacksRef.current.onError?.(outcome.error ?? 'payment_failed');
        })
        .catch(() => {
          if (!active || !isCurrentSolidgateConfirmOrigin(origin)) return;
          callbacksRef.current.onPending?.();
          callbacksRef.current.onError?.('payment_pending');
          scheduleRetry();
        });
    };

    runAttempt();
    return () => {
      active = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      controller?.abort();
      if (activeOrderRef.current === orderId) activeOrderRef.current = null;
    };
  }, [slug, sessionId]);
}
