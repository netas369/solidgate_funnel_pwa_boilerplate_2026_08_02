'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps the live board current.
 *
 * This replaces a `<meta http-equiv="refresh" content="10">`, which was a real
 * bug rather than a style preference. React 19 hoists <meta> into <head>; the
 * browser then schedules a navigation to the URL as resolved AT THAT MOMENT
 * (/dashboard/live). Clicking another tab is a client-side soft nav, so React
 * removes the element — but Chrome does not cancel an already-scheduled meta
 * refresh. Ten seconds later it fires anyway and hard-navigates back to Live,
 * from whatever page you had moved to.
 *
 * An interval owned by a mounted component cannot do that: leaving the tab
 * unmounts it and the cleanup clears the timer.
 *
 * router.refresh() re-fetches this route's server payload in place — no full
 * page load, so scroll position and focus survive, and the numbers just update.
 */
export function LiveAutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    // A board left open on a second monitor is the normal case here, so a
    // backgrounded tab must stop polling — otherwise it queries every 10s
    // indefinitely for nobody. Resumes (and refreshes immediately) on return.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [router, intervalMs]);

  return null;
}
