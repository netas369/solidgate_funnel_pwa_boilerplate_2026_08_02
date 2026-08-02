import posthog from 'posthog-js';
import {
  UTM_KEYS,
  attributionEventProperties,
  captureAttributionParams,
  readStoredAttribution,
  selectFirstTouchUtm,
  type UtmKey,
} from './attribution';

/**
 * Capture event to PostHog. Safe to call before init (PostHog queues internally).
 * SSR-safe: returns early if window is undefined.
 */
export function capturePostHogEvent(
  event: string,
  properties?: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return;
  posthog.capture(event, properties);
}

/** Clear an identified funnel session before a shared browser starts another one. */
export function resetPostHogIdentity(): void {
  if (typeof window === 'undefined') return;
  posthog.reset();
}

/**
 * Identify user in PostHog after email capture (D-04 error tracking).
 * SSR-safe: returns early if window is undefined.
 * Accepts optional properties to enrich person profile (locale, currency, etc.).
 */
export function identifyPostHogUser(
  sessionId: string,
  email: string,
  properties?: Record<string, unknown>
): void {
  if (typeof window === 'undefined') return;
  posthog.identify(sessionId, { email, ...properties });
}

/**
 * Register super properties that persist on every subsequent PostHog event.
 * SSR-safe. No consent check needed — register is local state, not a network call.
 */
export function setPostHogSuperProperties(
  locale: string,
  currency: string
): void {
  if (typeof window === 'undefined') return;
  posthog.register({ locale, currency });
}

/** Capture and register canonical first/last-touch campaign attribution. */
export function captureUTMParams(): void {
  if (typeof window === 'undefined') return;
  const snapshot = captureAttributionParams();
  if (!snapshot) return;
  const properties = attributionEventProperties(snapshot);
  const firstTouch = Object.fromEntries(
    Object.entries(properties).filter(([key]) => key.startsWith('first_touch_') || UTM_KEYS.includes(key as UtmKey)),
  );
  const lastTouch = Object.fromEntries(
    Object.entries(properties).filter(([key]) =>
      key.startsWith('last_touch_') ||
      key === 'fbc' ||
      key === 'fbp' ||
      key === 'landing_url' ||
      key === 'referrer',
    ),
  );
  posthog.register_once(firstTouch);
  posthog.register(lastTouch);
}

export function readStoredUTMParams(): Partial<Record<UtmKey, string>> {
  return selectFirstTouchUtm(readStoredAttribution());
}

export { UTM_KEYS, type UtmKey };

/**
 * Register a PostHog group for locale-level analytics segmentation.
 * SSR-safe: returns early if window is undefined.
 */
export function registerLocaleGroup(locale: string): void {
  if (typeof window === 'undefined') return;
  posthog.group('locale', locale, { name: locale });
}
