/**
 * Fire-and-forget session snapshot on each step advance (D-01, D-02).
 * Never blocks quiz navigation. Logs errors silently.
 *
 * Phase 1038 D-11: pass source: 'quiz' so sessions.source is consistently
 * written from quiz-flow callers. The server ignores duplicate writes on
 * subsequent calls (the column was already set on the INSERT), but passing
 * it explicitly keeps the request shape consistent and documents intent.
 */
export function persistSessionSnapshot(
  sessionId: string,
  currentStepId: string,
  answers: Record<string, unknown>,
  locale?: string
): void {
  // locale rides on every snapshot so a session whose creating persist was
  // lost (network drop, dying browser) is recreated on the next step instead
  // of 400-looping on "Missing locale for new session" all the way to payment.
  fetch('/api/session/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      currentStepId,
      answers,
      source: 'quiz',
      ...(locale ? { locale } : {}),
    }),
  }).catch((err) => {
    console.error('[persistence] Session persist failed:', err);
  });
}

/**
 * Fire-and-forget locale update (v46). Called when LanguageSwitcher
 * changes locale mid-quiz so sessions.locale reflects the new value.
 * Never blocks navigation; server validates against routing.locales.
 *
 * Phase 1038 D-11: source: 'quiz' makes the request shape consistent with
 * other quiz-flow persist calls.
 */
export function persistSessionLocale(sessionId: string, locale: string): void {
  fetch('/api/session/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, locale, source: 'quiz' }),
  }).catch((err) => {
    console.error('[persistence] Locale persist failed:', err);
  });
}

/**
 * Awaited lead capture on email submission (D-03, D-04, D-05).
 * Returns success/failure. Continues to results even on failure.
 */
const PENDING_LEADS_KEY = 'funnel_pending_leads';

function savePendingLead(sessionId: string, email: string, answers: Record<string, unknown>) {
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING_LEADS_KEY) ?? '[]') as unknown[];
    pending.push({ sessionId, email, answers, timestamp: Date.now() });
    localStorage.setItem(PENDING_LEADS_KEY, JSON.stringify(pending));
  } catch {
    // localStorage unavailable  -  nothing more we can do
  }
}

export function getPendingLeads(): Array<{ sessionId: string; email: string; answers: Record<string, unknown>; timestamp: number }> {
  try {
    return JSON.parse(localStorage.getItem(PENDING_LEADS_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function clearPendingLeads() {
  try { localStorage.removeItem(PENDING_LEADS_KEY); } catch { /* noop */ }
}

async function attemptCapture(
  sessionId: string,
  email: string,
  answers: Record<string, unknown>,
  consent?: { consentGivenAt: string; consentVersion: string; marketingConsent: boolean },
  locale?: string
): Promise<boolean> {
  // Phase 1038 D-11: source: 'quiz' distinguishes this lead capture from the
  // special-offer email gate (Plan 07, which POSTs source: 'special-offer').
  // The Phase 1037 AC integration fires here because source !== 'special-offer'
  //  -  the server's AC guard is intentionally permissive for 'quiz' and undefined.
  const res = await fetch('/api/session/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      email,
      answers,
      source: 'quiz',
      ...(locale ? { locale } : {}),
      ...(consent && {
        consentGivenAt: consent.consentGivenAt,
        consentVersion: consent.consentVersion,
        marketingConsent: consent.marketingConsent,
      }),
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    console.error('[lead-capture] Failed:', data.error ?? res.statusText);
    return false;
  }
  return true;
}

export async function captureLeadRecord(
  sessionId: string,
  email: string,
  answers: Record<string, unknown>,
  consent?: { consentGivenAt: string; consentVersion: string; marketingConsent: boolean },
  locale?: string
): Promise<{ success: boolean }> {
  try {
    // First attempt
    if (await attemptCapture(sessionId, email, answers, consent, locale)) {
      return { success: true };
    }
    // Retry once after a short delay
    await new Promise((r) => setTimeout(r, 1000));
    if (await attemptCapture(sessionId, email, answers, consent, locale)) {
      return { success: true };
    }
  } catch (err) {
    console.error('[lead-capture] Failed:', err);
  }

  // All attempts failed  -  save locally for later sync
  savePendingLead(sessionId, email, answers);
  return { success: false };
}
