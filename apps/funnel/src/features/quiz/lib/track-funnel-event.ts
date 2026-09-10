import { createClient } from '@repo/shared/supabase/client';
import type { Json } from '@repo/shared/types/database';
import { waitForSession } from './session-ready';

/**
 * Best-effort, fire-and-forget Supabase funnel_events insert (ANLYT-01).
 *
 * Awaits the session-ready gate first so the insert never races ahead of the
 * /api/quiz/session/create call that creates the sessions row
 * (funnel_events.session_id references sessions.id). The wait is capped at 8s
 * so a stuck gate degrades to a best-effort insert rather than dropping the
 * event silently. Returns void — callers treat it as fire-and-forget.
 */
export function trackFunnelEvent(
  sessionId: string,
  eventType: string,
  stepNumber?: number,
  metadata?: Json,
): void {
  void (async () => {
    await Promise.race([
      waitForSession(),
      new Promise<void>((resolve) => setTimeout(resolve, 8000)),
    ]);
    const supabase = createClient();
    const { error } = await supabase.from('funnel_events').insert({
      session_id: sessionId,
      event_type: eventType,
      step_number: stepNumber,
      metadata: metadata ?? {},
    });
    if (error) console.error('[funnel-event] Insert failed:', error.message);
  })();
}
