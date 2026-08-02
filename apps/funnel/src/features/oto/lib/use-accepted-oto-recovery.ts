'use client';

import { useEffect } from 'react';
import {
  ACCEPTED_OTO_RECOVERY_EVENT,
  acceptedOtoRecoveryKey,
  forgetAcceptedOtoRecoveryOrder,
  readAcceptedOtoRecoveryOrders,
  recordDeclinedAcceptedOtoOrder,
  type AcceptedOtoRecoveryOrder,
} from './accepted-oto-recovery';
import { resumeSolidgateOto } from './charge-oto';

const ACCEPTED_RECOVERY_RETRY_MS = 15_000;
const ACCEPTED_RECOVERY_MAX_PENDING_ATTEMPTS = 20;

export type AcceptedOtoRecoverySweepResult = {
  attemptedOrderIds: string[];
  pendingOrderIds: string[];
  declinedOrderIds: string[];
  redirectUrl: string | null;
  queueEmpty: boolean;
};

/**
 * Reconciles every supplied accepted order once, in queue order.
 *
 * A perpetually `processing` older order must not hide a later order that has
 * transitioned to `3ds_verify`, so a sweep never stops on an ordinary pending
 * result. It stops early only when the browser must enter an ACS challenge.
 */
export async function reconcileAcceptedOtoRecoverySweep(params: {
  sessionId: string;
  signal?: AbortSignal;
  orders?: AcceptedOtoRecoveryOrder[];
}): Promise<AcceptedOtoRecoverySweepResult> {
  const queue = params.orders ?? readAcceptedOtoRecoveryOrders(params.sessionId);
  const attemptedOrderIds: string[] = [];
  const pendingOrderIds: string[] = [];
  const declinedOrderIds: string[] = [];

  for (const order of queue) {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException('OTO recovery aborted', 'AbortError');
    }
    attemptedOrderIds.push(order.orderId);
    let outcome: Awaited<ReturnType<typeof resumeSolidgateOto>>;
    try {
      outcome = await resumeSolidgateOto({
        slug: order.productSlug,
        sessionId: params.sessionId,
        orderId: order.orderId,
        signal: params.signal,
      });
    } catch (error) {
      if (params.signal?.aborted) throw error;
      pendingOrderIds.push(order.orderId);
      continue;
    }

    if (outcome.redirecting) {
      if (outcome.verifyUrl) {
        return {
          attemptedOrderIds,
          pendingOrderIds: [...pendingOrderIds, order.orderId],
          declinedOrderIds,
          redirectUrl: outcome.verifyUrl,
          queueEmpty: false,
        };
      }
      pendingOrderIds.push(order.orderId);
      continue;
    }

    if (outcome.ok) {
      forgetAcceptedOtoRecoveryOrder(params.sessionId, order.orderId);
      continue;
    }

    if (outcome.pending || outcome.accepted) {
      pendingOrderIds.push(order.orderId);
      continue;
    }

    // A definitive decline/void/binding rejection cannot later become an ACS
    // challenge. Removing it also prevents a dead order blocking the queue —
    // but never silently: the buyer already advanced believing they bought
    // this, so a durable notice must tell them the purchase did not complete
    // (no money moved — a captured order resolves as outcome.ok above).
    //
    // Exception: grant_revoked means the charge DID capture and was then
    // refunded/disputed — the "your card was not charged" notice would be
    // false, and the reversal is already visible on the buyer's statement.
    if (outcome.code !== 'grant_revoked') {
      recordDeclinedAcceptedOtoOrder({
        sessionId: params.sessionId,
        orderId: order.orderId,
        productSlug: order.productSlug,
      });
      declinedOrderIds.push(order.orderId);
    }
    forgetAcceptedOtoRecoveryOrder(params.sessionId, order.orderId);
  }

  return {
    attemptedOrderIds,
    pendingOrderIds,
    declinedOrderIds,
    redirectUrl: null,
    queueEmpty: readAcceptedOtoRecoveryOrders(params.sessionId).length === 0,
  };
}

/**
 * Reconciles provider-accepted orders after the buyer has already advanced.
 *
 * Solidgate documents `processing` as an intermediate state and a saved-card
 * 1-click payment may still require 3DS. The oldest pending order is therefore
 * checked serially on every OTO page. A later ACS challenge owns the tab;
 * settled/failed orders are simply removed without navigating backwards.
 */
export function useAcceptedOtoRecovery(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const pendingAttempts = new Map<string, number>();

    const schedule = (delay = ACCEPTED_RECOVERY_RETRY_MS) => {
      if (!active || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void runSweep();
      }, delay);
    };

    const runSweep = async () => {
      if (!active || running) return;
      // The exact return-page hook owns an active ACS callback. The persistent
      // queue resumes on the next OTO mount after that history entry resolves.
      if (new URL(window.location.href).searchParams.has('sg_confirm')) return;
      const queue = readAcceptedOtoRecoveryOrders(sessionId);
      const retryable = queue.filter(
        (order) => (pendingAttempts.get(order.orderId) ?? 0)
          < ACCEPTED_RECOVERY_MAX_PENDING_ATTEMPTS,
      );
      if (retryable.length === 0) return;

      running = true;
      controller = new AbortController();
      try {
        const result = await reconcileAcceptedOtoRecoverySweep({
          sessionId,
          signal: controller.signal,
          orders: retryable,
        });
        if (!active) return;
        if (result.redirectUrl) {
          window.location.assign(result.redirectUrl);
          return;
        }

        const pendingSet = new Set(result.pendingOrderIds);
        for (const orderId of result.attemptedOrderIds) {
          if (pendingSet.has(orderId)) {
            pendingAttempts.set(orderId, (pendingAttempts.get(orderId) ?? 0) + 1);
          } else {
            pendingAttempts.delete(orderId);
          }
        }

        const remaining = readAcceptedOtoRecoveryOrders(sessionId);
        for (const orderId of [...pendingAttempts.keys()]) {
          if (!remaining.some((order) => order.orderId === orderId)) {
            pendingAttempts.delete(orderId);
          }
        }
        const hasFreshOrder = remaining.some(
          (order) => !result.attemptedOrderIds.includes(order.orderId),
        );
        const hasRetryablePending = remaining.some(
          (order) => (pendingAttempts.get(order.orderId) ?? 0)
            < ACCEPTED_RECOVERY_MAX_PENDING_ATTEMPTS,
        );
        if (hasRetryablePending) schedule(hasFreshOrder ? 0 : ACCEPTED_RECOVERY_RETRY_MS);
      } catch {
        if (!active) return;
        schedule();
      } finally {
        running = false;
        controller = null;
      }
    };

    const onQueueChanged = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== acceptedOtoRecoveryKey(sessionId)) return;
      } else {
        const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
        if (detail?.sessionId !== sessionId) return;
      }
      if (running) return;
      // Give the purchase callback time to perform its canonical navigation;
      // the next page normally takes ownership before this fires.
      if (timer !== null) clearTimeout(timer);
      timer = null;
      schedule(1_000);
    };

    window.addEventListener('storage', onQueueChanged);
    window.addEventListener(ACCEPTED_OTO_RECOVERY_EVENT, onQueueChanged);
    void runSweep();

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      window.removeEventListener('storage', onQueueChanged);
      window.removeEventListener(ACCEPTED_OTO_RECOVERY_EVENT, onQueueChanged);
    };
  }, [sessionId]);
}
