import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import type { TablesUpdate } from '@repo/shared/types/database';
import { routing } from '@repo/i18n/routing';
import { addContactToEmailList } from '@/lib/activecampaign/client';

// Valid entry points for a session row, matching the routes that create one:
//   quiz                — the main funnel
//   special-offer       — the discounted-intro abandonment landing page
//   special-offer-free  — the free-intro abandonment landing page
//
// sessions.source is a TEXT column (not an enum) so new entry points land
// without a migration — but the API rejects unknown values so a typo cannot
// silently pollute the analytics split between them.
//
// TODO(new product): rename these if your entry points differ, and keep
// [locale]/special-offer* in sync.
const ALLOWED_SOURCES = ['quiz', 'special-offer', 'special-offer-free'] as const;

/**
 * Answer keys a prior session must carry for the special-offer hydration
 * below to consider it "complete enough" to copy forward.
 *
 * These are matched as PostgREST JSONB predicates against sessions.quiz_answers
 * — a key the quiz never writes does not error, it just makes the lookup match
 * nothing forever, so `hydrated` would be permanently false and the feature
 * would look wired but never fire. Keep this list honest.
 *
 * Empty = hydrate from the most recent prior session for that email regardless
 * of which answers it holds, which is the sensible default for a generic quiz.
 *
 * TODO(new product): list the answer keys your follow-up step needs.
 */
const HYDRATION_REQUIRED_ANSWER_KEYS: readonly string[] = [];
type SessionUpdate = TablesUpdate<'sessions'>;

export async function POST(request: Request) {
  const body = (await request.json()) as {
    sessionId?: unknown;
    currentStepId?: SessionUpdate['current_step_id'];
    answers?: SessionUpdate['quiz_answers'];
    email?: SessionUpdate['email'];
    resultSegment?: SessionUpdate['result_segment'];
    consentGivenAt?: SessionUpdate['consent_given_at'];
    consentVersion?: SessionUpdate['consent_version'];
    marketingConsent?: SessionUpdate['marketing_consent'];
    locale?: unknown;
    source?: unknown; // Phase 1038 D-11
  };

  if (!body.sessionId || typeof body.sessionId !== 'string') {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const sessionId = body.sessionId;

  const update: SessionUpdate = {
    updated_at: new Date().toISOString(),
  };

  if (body.currentStepId !== undefined) {
    update.current_step_id = body.currentStepId;
  }

  if (body.answers !== undefined) {
    update.quiz_answers = body.answers;
  }

  if (body.email !== undefined) {
    update.email = body.email;
  }

  if (body.resultSegment !== undefined) {
    update.result_segment = body.resultSegment;
  }

  if (body.consentGivenAt !== undefined) {
    update.consent_given_at = body.consentGivenAt;
  }
  if (body.consentVersion !== undefined) {
    update.consent_version = body.consentVersion;
  }
  if (body.marketingConsent !== undefined) {
    // Business decision (2026-07-17): marketing consent is always granted,
    // regardless of what the client sends.
    update.marketing_consent = true;
  }

  const allowedLocales = routing.locales as readonly string[];

  if (body.locale !== undefined && (typeof body.locale !== 'string' || !allowedLocales.includes(body.locale))) {
    return NextResponse.json({ error: 'Invalid locale' }, { status: 400 });
  }

  // Phase 1038 D-11: source field tracks session origin for segmentation.
  // Allowed values: 'quiz' (default for the funnel) and 'special-offer'
  // (the new /[locale]/special-offer landing page). Unknown values are
  // rejected so a typo doesn't silently land bad data.
  if (body.source !== undefined) {
    if (
      typeof body.source !== 'string' ||
      !(ALLOWED_SOURCES as readonly string[]).includes(body.source)
    ) {
      return NextResponse.json({ error: 'Invalid source' }, { status: 400 });
    }
    update.source = body.source;
  }

  const admin = getSupabaseAdminClient();

  // ── Duplicate-account guard for /special-offer + /special-offer-free ────
  // Users hitting these abandonment landing pages with an email that already
  // owns an active entitlement (main subscription, lifetime, add-on, any
  // one-time upsell) get sent to /login instead of being allowed to re-buy.
  // Repeat purchases on the same account are a real and recurring support load.
  //
  // Fires only when:
  //   - source is one of the special-offer variants (the only entry points
  //     this guard is meant to police; the quiz flow has its own intro-offer
  //     claim guard inside /api/solidgate/create-session).
  //   - email is provided AND looks like an email.
  //
  // An "active entitlement" is status='active' AND revoked_at IS NULL AND
  // (expires_at IS NULL OR expires_at > now()) — matching the shared
  // entitlements helper and every access check in the PWA. Cancelled subs,
  // revoked rows, or expired trials do NOT block re-engagement.
  //
  // Fail-open policy: any query error logs '[duplicate-account-guard] ...'
  // and lets the flow proceed. The check is best-effort; webhook + grant
  // route guards remain the canonical defenses against duplicate grants.
  if (
    (body.source === 'special-offer' || body.source === 'special-offer-free') &&
    typeof body.email === 'string' &&
    body.email.includes('@')
  ) {
    try {
      // Indexed email→user lookup via the find_auth_user_id_by_email RPC.
      // The obvious admin.auth.admin.listUsers() approach only reads PAGE 1
      // and silently stopped matching once the project passed 200 auth users.
      const { data: matchedUserId, error: lookupErr } = await admin.rpc(
        'find_auth_user_id_by_email',
        { p_email: body.email },
      );
      if (lookupErr) {
        console.error(
          '[duplicate-account-guard] auth user lookup failed:',
          lookupErr.message,
          { session_id: sessionId },
        );
      } else if (typeof matchedUserId === 'string' && matchedUserId) {
        const nowIso = new Date().toISOString();
        const { data: active, error: entErr } = await admin
          .from('entitlements')
          .select('product_slug')
          .eq('payment_environment', currentPaymentEnvironment())
          .eq('user_id', matchedUserId)
          .eq('status', 'active')
          .is('revoked_at', null)
          .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
          .limit(1);
        if (entErr) {
          console.error(
            '[duplicate-account-guard] entitlements query failed:',
            entErr.message,
            { session_id: sessionId, user_id: matchedUserId },
          );
        } else if (active && active.length > 0) {
          console.info('[duplicate-account-guard] blocking repeat purchase', {
            session_id: sessionId,
            source: body.source,
            user_id: matchedUserId,
            active_slug: active[0].product_slug,
          });
          return NextResponse.json(
            {
              error: 'already_subscribed',
              message: 'An account with this email already has an active plan.',
            },
            { status: 409 },
          );
        }
      }
    } catch (guardErr) {
      console.error(
        '[duplicate-account-guard] unexpected error:',
        guardErr instanceof Error ? guardErr.message : guardErr,
        { session_id: sessionId },
      );
    }
  }

  const { data: existing } = await admin
    .from('sessions')
    .select('id, locale')
    .eq('id', sessionId)
    .maybeSingle();

  // Special-offer hydration: leads on /special-offer and /special-offer-free
  // arrive from an abandonment email — they already completed the quiz, and
  // their answers live in a prior sessions row keyed by the same email. Look
  // it up and copy quiz_answers + result_segment forward so the new session
  // does not have to re-ask. The client uses `hydrated` in the response to
  // decide whether to skip the follow-up question step or render it.
  //
  // Which prior sessions qualify is configured by
  // HYDRATION_REQUIRED_ANSWER_KEYS (see the note on that constant).
  let hydrated = false;
  const isSpecialSource =
    body.source === 'special-offer' || body.source === 'special-offer-free';
  if (
    !existing &&
    isSpecialSource &&
    typeof body.email === 'string' &&
    body.email.includes('@')
  ) {
    try {
      let priorQuery = admin
        .from('sessions')
        .select('quiz_answers, result_segment')
        .eq('email', body.email);
      for (const key of HYDRATION_REQUIRED_ANSWER_KEYS) {
        priorQuery = priorQuery.not(`quiz_answers->${key}`, 'is', null);
      }
      const { data: prior } = await priorQuery
        .neq('id', sessionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prior?.quiz_answers) {
        update.quiz_answers = prior.quiz_answers;
        if (prior.result_segment) update.result_segment = prior.result_segment;
        hydrated = true;
      }
    } catch (lookupErr) {
      // Fail-open: if the lookup throws, the new session is created without
      // hydration and the client's follow-up step catches it. Logged so ops
      // can spot a degraded recovery path.
      console.error(
        '[session/persist] hydration lookup failed:',
        lookupErr instanceof Error ? lookupErr.message : lookupErr,
      );
    }
  }

  if (!existing) {
    if (typeof body.locale !== 'string') {
      return NextResponse.json(
        { error: 'Missing locale for new session' },
        { status: 400 },
      );
    }
    const { error } = await admin
      .from('sessions')
      .insert({ id: sessionId, locale: body.locale, ...update });
    if (error) {
      console.error('[session/persist] insert failed', { sessionId, update, error });
      return NextResponse.json({ error: 'Failed to persist session', detail: error.message }, { status: 500 });
    }
  } else {
    // locale is mutable mid-quiz — the language switcher updates sessions.locale
    if (typeof body.locale === 'string') {
      update.locale = body.locale;
    }
    const { error } = await admin
      .from('sessions')
      .update(update)
      .eq('id', sessionId);
    if (error) {
      console.error('[session/persist] update failed', { sessionId, update, error });
      return NextResponse.json({ error: 'Failed to persist session', detail: error.message }, { status: 500 });
    }
  }

  // Phase 1037 (D-02, AC-01): Fire-and-forget AC email list add on email capture.
  // Phase 1038 D-10 (Pitfall 4): the special-offer page MUST NOT trigger AC.
  // Leads who land on /[locale]/special-offer are already on the main-funnel
  // AC list (added during their original quiz attempt)  -  adding them again
  // or to the wrong list breaks the abandonment automation that brought
  // them there. Condition is intentionally permissive: undefined source
  // (backward-compat) and 'quiz' both fire AC; only explicit 'special-offer'
  // skips it.
  //
  // Phase 1039 D-13: special-offer-free leads are ALSO already on the main-funnel
  // AC list from a prior quiz attempt (they're being re-engaged via a 24h
  // abandonment email that AC itself sent). Firing addContactToEmailList again
  // would be either a no-op (idempotent path) or a list-move that breaks the
  // abandonment automation  -  so skip it, matching Phase 1038 D-10 for 'special-offer'.
  if (
    body.email &&
    typeof body.email === 'string' &&
    body.source !== 'special-offer' &&
    body.source !== 'special-offer-free'
  ) {
    const effectiveLocale = (typeof body.locale === 'string' ? body.locale : existing?.locale) as string | undefined;
    if (effectiveLocale) {
      void addContactToEmailList(body.email, effectiveLocale).catch((err) => {
        console.error('[session/persist] AC email list add failed:', err instanceof Error ? err.message : err);
      });
    }
  }

  return NextResponse.json({ ok: true, hydrated });
}
