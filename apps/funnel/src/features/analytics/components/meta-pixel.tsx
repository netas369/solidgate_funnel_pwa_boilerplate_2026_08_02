'use client';

import Script from 'next/script';
import { initMetaPixel } from '../lib/meta-pixel';

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID;

/**
 * fbq queue setup snippet  -  queues fbq() calls until fbevents.js finishes loading.
 * This must run before the library script so early calls are buffered.
 */
const FBQ_QUEUE_SNIPPET = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[]}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');`;

/**
 * Meta Pixel component  -  loads base pixel code and initializes on load.
 * Renders nothing if NEXT_PUBLIC_META_PIXEL_ID is not set.
 */
export function MetaPixel() {
  if (!PIXEL_ID) return null;

  return (
    <>
      {/* Queue setup  -  buffers fbq() calls before library loads.
          Uses afterInteractive (beforeInteractive requires root layout in App Router).
          Inline script executes before the src-based script below since there is
          nothing to fetch. */}
      <Script
        id="meta-pixel-queue"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: FBQ_QUEUE_SNIPPET }}
      />

      {/* Library load  -  calls initMetaPixel() (init + PageView) once loaded.
          onError catches network/CDN failures; initMetaPixel itself guards
          against the stub-only state where onLoad fires but the library body
          was empty (e.g. CDN 204). */}
      <Script
        id="meta-pixel-lib"
        strategy="afterInteractive"
        src="https://connect.facebook.net/en_US/fbevents.js"
        onLoad={initMetaPixel}
        onError={() =>
          console.warn('[meta-pixel] fbevents.js failed to load from CDN')
        }
      />

      {/* noscript fallback */}
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: 'none' }}
          src={`https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`}
          alt=""
        />
      </noscript>
    </>
  );
}
