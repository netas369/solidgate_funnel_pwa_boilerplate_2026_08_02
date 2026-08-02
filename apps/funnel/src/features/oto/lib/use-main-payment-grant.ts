'use client';

/**
 * The settlement bridge between the main checkout and the OTO chain.
 *
 * A 3DS issuer that full-page-redirects hands the buyer back with the main
 * order still only AUTHORIZED. OTO1 must not charge a card whose main payment
 * has not been verified, but it also must not make an already-paying buyer sit
 * behind a spinner while Solidgate captures. This hook resolves that:
 *
 *   pending   → the page stays locked and shows the calm payment-pending notice
 *   accepted  → the grant verified a paid `auth_ok` reservation AND published
 *               the saved card, so the page unlocks; the poll keeps running
 *               only to fire the main capture analytics and drop the marker
 *   ready     → captured (or a zero-amount authorized trial); marker cleared
 *   terminal  → the payment failed for good; the page stays locked
 *
 * Extracted verbatim (behaviour-wise) from the retired oto1-lifetime page —
 * this logic exists nowhere else.
 */

import { useEffect, useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import { useQuizStore } from '@/stores/quiz-store';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { attributionEventProperties } from '@/features/analytics/lib/attribution';
import { purchaseEventId } from '@/features/analytics/lib/checkout-context';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';
import {
  clearMainPaymentRecovery,
  MAIN_PAYMENT_RECOVERY_MAX_AGE_MS,
  parseMainPaymentRecoveryOrder,
  readMainPaymentRecovery,
  saveMainPaymentRecovery,
  type MainPaymentRecoveryMarker,
} from './main-payment-recovery';

export type MainGrantState = 'idle' | 'pending' | 'accepted' | 'ready' | 'terminal';

export const MAIN_GRANT_POLL_INTERVAL_MS = 2_000;
export const MAIN_GRANT_REQUEST_TIMEOUT_MS = 15_000;

export interface MainPaymentGrant {
  /** The validated recovery marker, or null when there is nothing to watch. */
  marker: MainPaymentRecoveryMarker | null;
  state: MainGrantState;
  /** True while the page must refuse to charge or advance. */
  locked: boolean;
  /**
   * Drop the marker before navigating away. A stale marker re-arms the
   * 'pending' lock on a back-navigation and — once a lifetime purchase has
   * cancelled the main subscription — would dead-end a fully-paid buyer in a
   * false `grant_revoked` error. Server side the webhook owns capture either
   * way. A terminal state keeps its marker so the error survives a re-render.
   */
  release: () => void;
}

/** Watches the main order referenced by ?sg_main (or a stored marker). */
export function useMainPaymentGrant(enabled: boolean): MainPaymentGrant {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mainOrderParam = searchParams.get('sg_main');
  const { track } = useAnalytics();

  const [marker, setMarker] = useState<MainPaymentRecoveryMarker | null>(null);
  const [state, setState] = useState<MainGrantState>('idle');

  // The accepted `auth_ok` handoff carries the exact order in both the URL and
  // localStorage. The URL survives a full refresh; storage recovers a browser
  // back/forward transition that dropped the query. Neither is authority — the
  // grant API and the signed provisional cookie still verify the provider/DB.
  useEffect(() => {
    if (!enabled) return;
    const parsedQuery = parseMainPaymentRecoveryOrder(mainOrderParam);
    const stored = readMainPaymentRecovery();
    const resolved = parsedQuery
      ? stored?.orderId === parsedQuery.orderId
        ? stored
        : saveMainPaymentRecovery(parsedQuery)
      : stored;
    if (!resolved) return;
    useQuizStore.getState().grantPurchaseAuthorization(resolved.sessionId);
    setMarker(resolved);
    setState('pending');
  }, [enabled, mainOrderParam]);

  useEffect(() => {
    if (!enabled || !marker || (state !== 'pending' && state !== 'accepted')) return;
    let cancelled = false;
    let timer: number | undefined;

    const finish = (next: 'ready' | 'terminal') => {
      clearMainPaymentRecovery();
      setState(next);
      if (next === 'ready') {
        setMarker(null);
        if (mainOrderParam) router.replace('/oto/1');
      }
    };

    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - marker.createdAt > MAIN_PAYMENT_RECOVERY_MAX_AGE_MS) {
        // An unlocked page must not re-lock with an error because settlement
        // outlived the marker: drop the watch quietly and stay unlocked. Only
        // a page still gated on the pending grant fails terminally here.
        if (state === 'accepted') {
          clearMainPaymentRecovery();
          setMarker(null);
          return;
        }
        finish('terminal');
        return;
      }
      const controller = new AbortController();
      const requestTimeout = window.setTimeout(
        () => controller.abort(),
        MAIN_GRANT_REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch('/api/solidgate/grant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify({ orderId: marker.orderId, sessionId: marker.sessionId }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          captured?: boolean;
          settled?: boolean;
          fullyCaptured?: boolean;
          authorizedTrial?: boolean;
          accepted?: boolean;
          authorized?: boolean;
          terminal?: boolean;
          code?: string;
          status?: string;
          subscriptionId?: string;
        };
        if (cancelled) return;
        const captured =
          data.captured === true || data.settled === true || data.fullyCaptured === true;
        if (response.ok && data.ok === true && (captured || data.authorizedTrial === true)) {
          if (marker.checkout) {
            try {
              const eventId = purchaseEventId(marker.orderId);
              const productCategory =
                marker.checkout.funnel_variant === 'special_free'
                  ? 'special-free'
                  : marker.checkout.funnel_variant === 'special_1eur'
                    ? 'special-1eur'
                    : 'main';
              track('checkout_completed', {
                ...marker.checkout,
                ...attributionEventProperties(),
                session_id: marker.sessionId,
                orderId: marker.orderId,
                order_id: marker.orderId,
                solidgate_order_id: marker.orderId,
                transactionId: marker.orderId,
                transaction_id: marker.orderId,
                subscription_id: data.subscriptionId,
                eventId,
                event_id: eventId,
                $insert_id: eventId,
                payment_status: data.status ?? 'settle_ok',
                settled: captured,
                authorized_trial: data.authorizedTrial === true,
                product_category: productCategory,
                value: purchaseEventValue(
                  marker.checkout.amount_cents,
                  marker.checkout.currency,
                ),
              });
            } catch (analyticsError) {
              console.error('[main-payment-grant] capture tracking failed:', analyticsError);
            }
          }
          finish('ready');
          return;
        }
        if (
          data.terminal === true ||
          response.status === 402 ||
          (response.status === 409 && data.code === 'grant_revoked')
        ) {
          finish('terminal');
          return;
        }
        if (
          state === 'pending' &&
          response.status === 202 &&
          data.accepted === true &&
          data.authorized === true &&
          data.status === 'auth_ok'
        ) {
          // The grant verified the paid authorization and published the saved
          // card + payment cookie. Unlock the page; the effect restarts under
          // 'accepted' and keeps watching the same order for its capture.
          setState('accepted');
          return;
        }
      } catch {
        // Network and timeout ambiguity stay bound to this same order.
      } finally {
        window.clearTimeout(requestTimeout);
      }
      if (!cancelled) timer = window.setTimeout(poll, MAIN_GRANT_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, marker, state, router, mainOrderParam, track]);

  return {
    marker,
    state,
    locked: state === 'pending' || state === 'terminal',
    release: () => {
      if (state === 'terminal') return;
      clearMainPaymentRecovery();
    },
  };
}
