'use client';


/**
 * Client-side companion to /api/meta/capi. Fires alongside the browser
 * fbq('track', ...) call using the same eventID, so the server-side
 * Conversions API event dedupes against the browser event in Meta's
 * pipeline.
 *
 * keepalive=true lets the request survive page navigation (important for
 * checkout_completed which immediately redirects to /success or /oto/1).
 */

type ClientCapiInput = {
  eventName: string;
  eventId: string;
  sessionId?: string;
  email?: string;
  customData?: {
    value?: number;
    currency?: string;
    content_ids?: string[];
    content_type?: string;
  };
};

export function sendCapiFromBrowser(input: ClientCapiInput): void {
  if (typeof window === 'undefined') return;

  const body = JSON.stringify({
    eventName: input.eventName,
    eventId: input.eventId,
    sessionId: input.sessionId,
    eventSourceUrl: window.location.href,
    email: input.email,
    customData: input.customData,
  });

  // Fire-and-forget; failures are logged server-side and never block the UI.
  fetch('/api/meta/capi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    // Network errors are non-fatal for analytics.
  });
}
