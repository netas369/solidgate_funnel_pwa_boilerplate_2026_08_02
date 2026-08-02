'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import posthog from 'posthog-js';

/**
 * Captures PostHog $pageview events on route changes.
 *
 * The Providers component sets `capture_pageview: false` to avoid double-counting
 * in single-page-app navigation. This component manually fires $pageview whenever
 * the pathname or search params change.
 *
 * Uses `next/navigation` usePathname (not i18n-aware) intentionally so that
 * PostHog sees the full URL path including locale prefix (e.g. /lt/quiz).
 * This gives accurate per-locale funnel analysis in PostHog.
 */
export function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;

    const url = searchParams?.size
      ? `${pathname}?${searchParams.toString()}`
      : pathname;

    posthog.capture('$pageview', { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}
