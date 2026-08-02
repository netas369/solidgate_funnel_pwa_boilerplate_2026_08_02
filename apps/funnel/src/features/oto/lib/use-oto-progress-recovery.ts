'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  canonicalProgressKey,
  flushPendingOtoProgressBestEffort,
  OTO_CANONICAL_PROGRESS_EVENT,
  readCanonicalOtoProgress,
  resolveCanonicalOtoRecoveryTarget,
} from './advance-oto';

/** Retries a prior page's durable progress write whenever an OTO mounts. */
export function useOtoProgressRecovery(
  sessionId: string | null,
  enabled: boolean,
): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let lastTarget: string | null = null;
    const followCanonicalProgress = () => {
      // An ACS return owns this exact history entry until its bound order has
      // been reconciled. Replacing it here would unmount the confirmation hook
      // and abort the status request before it can finish.
      if (new URL(window.location.href).searchParams.has('sg_confirm')) return;
      const target = resolveCanonicalOtoRecoveryTarget(
        readCanonicalOtoProgress(sessionId),
        window.location.pathname,
      );
      if (!target || target === lastTarget) return;
      lastTarget = target;
      router.replace(target);
    };
    const handleCanonical = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
      if (detail?.sessionId === sessionId) followCanonicalProgress();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === canonicalProgressKey(sessionId)) followCanonicalProgress();
    };

    // A response may have completed after the previous page's 250 ms UI
    // budget but before this component mounted.
    followCanonicalProgress();
    window.addEventListener(OTO_CANONICAL_PROGRESS_EVENT, handleCanonical);
    window.addEventListener('storage', handleStorage);
    void flushPendingOtoProgressBestEffort({ sessionId }).then(followCanonicalProgress);
    return () => {
      window.removeEventListener(OTO_CANONICAL_PROGRESS_EVENT, handleCanonical);
      window.removeEventListener('storage', handleStorage);
    };
  }, [enabled, router, sessionId]);
}
