import { sendGTMEvent } from '@next/third-parties/google';

/**
 * Push event to GTM dataLayer (D-10 schema).
 * SSR-safe: returns early if window is undefined.
 */
export function pushDataLayerEvent(
  event: string,
  metadata?: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return;
  sendGTMEvent({ event, ...metadata });
}
