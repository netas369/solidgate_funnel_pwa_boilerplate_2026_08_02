'use client';

import posthog from 'posthog-js';
import { PostHogProvider } from 'posthog-js/react';
import { Suspense, useEffect, useRef } from 'react';
import { LOCALE_CURRENCY_MAP } from '@repo/shared/price-map';
import { PostHogPageView } from '@/features/analytics/components/posthog-pageview';
import {
  setPostHogSuperProperties,
  captureUTMParams,
  registerLocaleGroup,
} from '@/features/analytics/lib/posthog';
import { captureFbclidToCookie } from '@/features/analytics/lib/fb-cookies';

export function Providers({
  children,
  locale,
}: {
  children: React.ReactNode;
  locale: string;
}) {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    initialized.current = true;
    posthog.init(key, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: true,
    });
    // Capturing is on for everyone. Flip any opt-out persisted by the retired
    // consent banner back to opted-in, without emitting an $opt_in event.
    if (posthog.has_opted_out_capturing()) {
      posthog.opt_in_capturing({ captureEventName: null });
    }

    // Enrich every subsequent event with locale/currency super properties
    const currency =
      LOCALE_CURRENCY_MAP[locale as keyof typeof LOCALE_CURRENCY_MAP] ?? 'eur';
    setPostHogSuperProperties(locale, currency);
    captureUTMParams();
    captureFbclidToCookie();
    registerLocaleGroup(locale);
  }, [locale]);

  return (
    <PostHogProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </PostHogProvider>
  );
}
