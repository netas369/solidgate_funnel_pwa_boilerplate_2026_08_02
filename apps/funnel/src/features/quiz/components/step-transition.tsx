'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

interface StepTransitionProps {
  questionId: string;
  direction: 'forward' | 'backward';
  children: React.ReactNode;
}

const EASE_CURVE: [number, number, number, number] = [0.32, 0.72, 0, 1];
const X_OFFSET = 200;

export function StepTransition({
  questionId,
  direction,
  children,
}: StepTransitionProps) {
  const shouldReduceMotion = useReducedMotion();
  const [isRtl, setIsRtl] = useState(false);

  useEffect(() => {
    setIsRtl(document.documentElement.dir === 'rtl');
  }, []);

  // RTL languages (Hebrew/Arabic): slide animations with framer-motion's
  // AnimatePresence + popLayout can leave the new child stuck at its initial
  // x offset, causing content to appear permanently shifted ~200px to the
  // right. Disable horizontal slide for RTL — use opacity-only crossfade.
  const disableSlide = shouldReduceMotion || isRtl;

  const xInitial = disableSlide
    ? 0
    : direction === 'forward'
      ? X_OFFSET
      : -X_OFFSET;

  const xExit = disableSlide
    ? 0
    : direction === 'forward'
      ? -X_OFFSET
      : X_OFFSET;

  return (
    <div className="overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={questionId}
          style={{ willChange: 'transform, opacity' }}
          initial={{ x: xInitial, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: xExit, opacity: 0 }}
          transition={{ duration: 0.12, ease: EASE_CURVE }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
