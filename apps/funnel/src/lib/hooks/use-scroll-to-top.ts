'use client';

import { useEffect, useRef } from 'react';

/**
 * Scrolls the window to (0, 0) once after the `ready` flag flips to true.
 * Useful for pages that render `null` during hydration/funnel gates so the
 * browser doesn't restore the prior page's scroll position once content
 * appears. Fires only once per mount via a ref guard.
 */
export function useScrollToTop(ready: boolean = true): void {
  const hasScrolledRef = useRef<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!ready) return;
    if (hasScrolledRef.current) return;

    hasScrolledRef.current = true;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [ready]);
}
