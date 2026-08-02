import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  Serwist,
  CacheFirst,
  ExpirationPlugin,
  CacheableResponsePlugin,
  RangeRequestsPlugin,
} from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// ── Audio runtime cache ─────────────────────────────────────────────────────
// Caches media served from Supabase Storage's public `audio` bucket so a
// previously-played track works offline. Files are immutable per name, so
// CacheFirst is correct. RangeRequestsPlugin is what makes scrubbing/seeking
// work when the audio is served from the cache — without it Safari refuses to
// play a cached response because it cannot honour the Range request.
//
// TODO(new product): drop this whole block if the product ships no audio.
const audioRuntimeCache = {
  matcher: ({ url }: { url: URL }) =>
    url.pathname.startsWith("/storage/v1/object/public/audio/"),
  handler: new CacheFirst({
    cacheName: "audio-files",
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200, 206] }),
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
        purgeOnQuotaError: true,
      }),
      new RangeRequestsPlugin(),
    ],
  }),
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [audioRuntimeCache, ...defaultCache],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
