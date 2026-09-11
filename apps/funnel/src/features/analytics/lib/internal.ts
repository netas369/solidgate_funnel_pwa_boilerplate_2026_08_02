'use client';

import { waitForSession } from '@/features/quiz/lib/session-ready';

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

function newEventKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Best-effort first-party analytics delivery. The API route supplies the
 * project/environment identifiers and binds any authenticated user itself.
 */
export function captureInternalEvent(
  eventName: string,
  properties?: Record<string, unknown>,
  options: { keepalive?: boolean; eventKey?: string } = {},
): void {
  if (typeof window === 'undefined' || !EVENT_NAME_PATTERN.test(eventName)) return;
  const sessionId = typeof properties?.session_id === 'string' ? properties.session_id : null;

  void (async () => {
    if (sessionId) {
      await Promise.race([
        waitForSession(),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    }

    try {
      await fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: options.keepalive ?? false,
        body: JSON.stringify({
          eventName,
          eventKey: options.eventKey ?? newEventKey(),
          sessionId,
          properties: properties ?? {},
        }),
      });
    } catch {
      // Analytics must never interrupt the funnel experience.
    }
  })();
}
