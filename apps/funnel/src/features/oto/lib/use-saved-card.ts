'use client';

/**
 * The saved-card gate for the first one-click OTO.
 *
 * The card is vaulted by the main checkout, but the token is published by a
 * provider/webhook round-trip that can land AFTER the buyer reaches OTO1.
 * Polling a bounded window (rather than reading once) is what stops a paying
 * buyer from seeing "no card on file" a second before the card appears — and
 * the bound is what stops the page spinning forever when there genuinely is
 * no card.
 *
 * Extracted verbatim (behaviour-wise) from the retired oto1-lifetime page.
 */

import { useCallback, useEffect, useState } from 'react';
import { otoPmInfoUrl } from './charge-oto';

export type SavedCard = { brand: string; last4: string } | null;
export type SavedCardState = 'loading' | 'ready' | 'missing';

export const PM_INFO_POLL_INTERVAL_MS = 1_500;
export const PM_INFO_REQUEST_TIMEOUT_MS = 5_000;
export const PM_INFO_POLL_WINDOW_MS = 20_000;

export interface SavedCardGate {
  card: SavedCard;
  state: SavedCardState;
  /** Restarts the bounded window; wired to a manual "try again" button. */
  retry: () => void;
}

export function useSavedCard(params: {
  sessionId: string | null;
  /** False while the page is not eligible to render at all. */
  enabled: boolean;
  /**
   * True while a main payment is still pending or has failed. The card check
   * is meaningless then, so it resets to 'loading' rather than reporting a
   * spurious 'missing'.
   */
  paused?: boolean;
}): SavedCardGate {
  const { sessionId, enabled, paused = false } = params;
  const [card, setCard] = useState<SavedCard>(null);
  const [state, setState] = useState<SavedCardState>('loading');
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    if (paused) {
      setCard(null);
      setState('loading');
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    let activeController: AbortController | undefined;
    const deadline = Date.now() + PM_INFO_POLL_WINDOW_MS;

    const finishMissing = () => {
      if (cancelled) return;
      setCard(null);
      setState('missing');
    };

    const scheduleRetry = (check: () => Promise<void>) => {
      if (cancelled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        finishMissing();
        return;
      }
      retryTimer = window.setTimeout(
        () => void check(),
        Math.min(PM_INFO_POLL_INTERVAL_MS, remainingMs),
      );
    };

    const check = async (): Promise<void> => {
      if (cancelled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        finishMissing();
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      const requestTimeout = window.setTimeout(
        () => controller.abort(),
        Math.min(PM_INFO_REQUEST_TIMEOUT_MS, remainingMs),
      );

      try {
        const response = await fetch(otoPmInfoUrl(sessionId), {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const data = (await response.json().catch(() => ({}))) as {
          brand?: string;
          last4?: string;
          code?: string;
        };
        if (cancelled) return;

        if (response.ok) {
          if (data.brand && data.last4) {
            setCard({ brand: data.brand, last4: data.last4 });
            setState('ready');
          } else {
            finishMissing();
          }
          return;
        }

        if (response.status === 409 && data.code === 'no_saved_card') {
          scheduleRetry(check);
          return;
        }

        finishMissing();
      } catch {
        // A timeout or transient network failure may race provider/webhook
        // reconciliation. Keep checking only inside the same bounded window.
        scheduleRetry(check);
      } finally {
        window.clearTimeout(requestTimeout);
        if (activeController === controller) activeController = undefined;
      }
    };

    setCard(null);
    setState('loading');
    void check();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      activeController?.abort();
    };
  }, [enabled, sessionId, paused, epoch]);

  const retry = useCallback(() => setEpoch((value) => value + 1), []);

  return { card, state, retry };
}
