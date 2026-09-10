/**
 * Module-level gate that resolves once the session row has been created in
 * the database. trackFunnelEvent() awaits this so a funnel_events insert
 * never races ahead of the /api/quiz/session/create call that creates the
 * sessions row (funnel_events.session_id references sessions.id).
 */

let ready = false;
let resolveGate: (() => void) | null = null;
let gate: Promise<void> | null = null;

/**
 * Call once session initialization has settled (success OR failure).
 * On failure the gate is still opened so funnel events fall back to a
 * best-effort insert instead of hanging forever.
 */
export function markSessionReady(): void {
  ready = true;
  resolveGate?.();
}

/** Resolves when the session DB row exists (or session creation has settled). */
export function waitForSession(): Promise<void> {
  if (ready) return Promise.resolve();
  if (!gate) {
    gate = new Promise<void>((r) => {
      resolveGate = r;
    });
  }
  return gate;
}

/** Reset for a new quiz session — called on quiz mount before the session is created. */
export function resetSessionGate(): void {
  ready = false;
  gate = new Promise<void>((r) => {
    resolveGate = r;
  });
}
