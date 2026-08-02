/**
 * Generate an event ID used to dedupe a browser pixel event against the
 * matching server-side Conversions API event. Meta dedupes by (event_name,
 * eventID) within a 28-day window, so the same UUID must be passed to both
 * fbq('track', name, params, { eventID }) on the client AND the CAPI POST
 * server-side.
 *
 * crypto.randomUUID is available everywhere we run (modern browsers,
 * Node 19+, Edge runtime).
 */
export function generateMetaEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Defensive fallback. Should never be reached on supported runtimes.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
