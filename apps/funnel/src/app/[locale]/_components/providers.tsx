'use client';

import { Suspense, useEffect, useRef } from 'react';
import { InternalPageView } from '@/features/analytics/components/internal-pageview';
import { captureAttributionParams } from '@/features/analytics/lib/attribution';
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
    initialized.current = true;
    captureAttributionParams();
    captureFbclidToCookie();
  }, [locale]);

  return (
    <>
      <Suspense fallback={null}>
        <InternalPageView />
      </Suspense>
      {children}
    </>
  );
}
