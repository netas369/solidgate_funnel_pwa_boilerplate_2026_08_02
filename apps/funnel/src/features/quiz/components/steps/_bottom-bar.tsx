'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';

interface BottomBarProps {
  children: React.ReactNode;
  maxWidth?: number;
}

/**
 * Sticky-to-viewport action bar for quiz steps.
 *
 * Implemented as a React portal to document.body because the quiz step is
 * rendered inside a `motion.div` (StepTransition) that applies `transform`,
 * which establishes a containing block for `position: fixed` and causes
 * fixed children to anchor to the motion div instead of the viewport.
 * Portaling sidesteps this entirely.
 */
export function BottomBar({ children, maxWidth = 640 }: BottomBarProps) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div
      className="lmRoot"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        background: 'var(--paper)',
        borderTop: '1px solid var(--ink)',
        padding: 'calc(14px) 22px calc(14px + env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ maxWidth, margin: '0 auto' }}>{children}</div>
    </div>,
    document.body,
  );
}
