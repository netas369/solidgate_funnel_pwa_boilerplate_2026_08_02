'use client';

import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';

/**
 * Shared behaviour for interstitial quiz steps that carry no Continue button:
 * they play for a beat, show a filling bar, and move on by themselves.
 *
 * Used by the checkpoint screens (step7, step14, step18, step19). Their
 * `onContinue` must be wired to a history-replacing navigation in quiz-page —
 * with a normal push, Back from the following step would land here and be
 * bounced straight forward again.
 */
export const AUTO_ADVANCE_MS = 4000;

export function useAutoAdvance(
  stepId: string,
  nextStepId: string,
  onContinue: (nextStepId: string) => void,
  /** Override for screens that need longer to read. Pass the same value to
   *  `AutoAdvanceBar` so the fill lands exactly when the step turns over. */
  durationMs: number = AUTO_ADVANCE_MS,
) {
  const advancedRef = useRef(false);
  // Kept in a ref so a new `onContinue` identity can't restart the countdown
  // half-way through.
  const onContinueRef = useRef(onContinue);
  onContinueRef.current = onContinue;

  useEffect(() => {
    // Re-arm on step change — these views render without the keyed
    // StepTransition wrapper (they're in the isLoading set), so React may reuse
    // the same instance across two of them.
    advancedRef.current = false;
    const timer = window.setTimeout(() => {
      if (advancedRef.current) return;
      advancedRef.current = true;
      onContinueRef.current(nextStepId);
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [stepId, nextStepId, durationMs]);
}

/**
 * The countdown bar that replaces the Continue button. Decorative — the step's
 * own copy carries the meaning, so it stays out of the accessibility tree.
 */
export function AutoAdvanceBar({ durationMs = AUTO_ADVANCE_MS }: { durationMs?: number }) {
  return (
    <div style={{ flexShrink: 0, padding: '8px 50px 12px' }} aria-hidden="true">
      <div
        style={{
          width: '100%',
          height: 6,
          borderRadius: 100,
          overflow: 'hidden',
          background: 'rgba(185,135,251,0.22)',
          border: '1px solid rgba(185,135,251,0.35)',
        }}
      >
        <motion.div
          style={{
            height: '100%',
            borderRadius: 100,
            background: 'linear-gradient(90deg, #4f397e 0%, #704ebf 50%, #b987fb 100%)',
          }}
          initial={{ width: '0%' }}
          animate={{ width: '100%' }}
          transition={{ duration: durationMs / 1000, ease: 'linear' }}
        />
      </div>
    </div>
  );
}
