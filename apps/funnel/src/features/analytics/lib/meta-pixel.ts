type FbqOptions = { eventID?: string };
type FbqStandard = (
  method: 'track',
  event: string,
  params?: Record<string, unknown>,
  options?: FbqOptions,
) => void;
type FbqCustom = (
  method: 'trackCustom',
  event: string,
  params?: Record<string, unknown>,
  options?: FbqOptions,
) => void;
type FbqInit = (
  method: 'init',
  pixelId: string,
  userData?: Record<string, string>,
) => void;
type Fbq = (FbqStandard & FbqCustom & FbqInit) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  loaded?: boolean;
  version?: string;
};

declare global {
  interface Window {
    fbq?: Fbq;
  }
}

let pendingHashedEmail: string | undefined;

/**
 * Verify the real fbevents.js library executed, not just the inline stub queue.
 * The stub queues calls forever if `callMethod` is missing (e.g. CDN returns
 * 204, ad-blocker intercept, network failure). Calling track in stub state
 * silently drops every event with no error — this guard prevents that.
 */
function isPixelLibraryLoaded(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.fbq === 'function' &&
    typeof window.fbq.callMethod === 'function'
  );
}

/**
 * Re-init the pixel with hashed user data (Meta Advanced Matching). Subsequent
 * fbq events automatically include these identifiers, which significantly
 * improves Meta's match rate — especially for iOS 14+ traffic where browser
 * tracking is heavily limited.
 *
 * Call AFTER email capture (e.g. quiz lead step). The pre-hashed
 * value must be SHA-256 of a normalized (trim+lowercase) email; the existing
 * hashEmail() helper produces the correct format.
 *
 * SSR-safe and a no-op if the real library never executed.
 */
export function setMetaUserData(hashedEmail: string): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!pixelId) return;
  if (!/^[a-f0-9]{64}$/i.test(hashedEmail)) return;
  // Keep the value if email capture wins the race against fbevents.js. The
  // later initMetaPixel call will initialize with the same advanced-matching
  // data rather than permanently losing it.
  pendingHashedEmail = hashedEmail.toLowerCase();
  if (!isPixelLibraryLoaded()) return;
  window.fbq?.('init', pixelId, { em: pendingHashedEmail });
}

/**
 * Initialize Meta Pixel  -  call once after fbevents.js loads.
 * SSR-safe: returns early if window is undefined.
 */
export function initMetaPixel(): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!pixelId) return;
  if (!isPixelLibraryLoaded()) {
    console.warn(
      '[meta-pixel] fbevents.js failed to execute (stub-only state); init skipped',
    );
    return;
  }
  window.fbq?.(
    'init',
    pixelId,
    pendingHashedEmail ? { em: pendingHashedEmail } : undefined,
  );
  window.fbq?.('track', 'PageView');
}

/**
 * Track a Meta Pixel standard event (e.g. Lead, Purchase, AddToCart).
 * SSR-safe. Returns whether fbq was actually invoked: false means the real
 * library never executed (stub state — CDN failure or blocker) and the event
 * was silently dropped. Callers use this to report delivery diagnostics.
 */
export function trackMetaEvent(
  event: string,
  params?: Record<string, unknown>,
  options?: FbqOptions,
): boolean {
  if (typeof window === 'undefined') return false;
  if (!isPixelLibraryLoaded()) return false;
  window.fbq?.('track', event, params, options);
  return true;
}

/**
 * Track a Meta Pixel custom event (e.g. Upsell).
 * SSR-safe.
 */
export function trackMetaCustomEvent(
  event: string,
  params?: Record<string, unknown>,
  options?: FbqOptions,
): boolean {
  if (typeof window === 'undefined') return false;
  if (!isPixelLibraryLoaded()) return false;
  window.fbq?.('trackCustom', event, params, options);
  return true;
}
