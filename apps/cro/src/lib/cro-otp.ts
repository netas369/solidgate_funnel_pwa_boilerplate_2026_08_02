// server-only.
//
// A deliberately minimal OTP flow for staff, NOT a reuse of
// @repo/shared/auth/{request,verify}-otp.
//
// Those helpers are excellent for customers and wrong here for two reasons:
//
//   1. They call getSupabaseAdminClient(), which needs SUPABASE_SERVICE_ROLE_KEY
//      in this app's environment. That single env var would undo the property
//      the whole CRO design rests on — apps/cro holds no credential capable of
//      reading sessions.quiz_answers, so "aggregates only" is enforced by
//      Postgres rather than by reviewers noticing.
//   2. Their extra behaviour is customer machinery that must not run for staff.
//      handleVerifyOtp links every sessions row matching the email to the user
//      who just signed in — so an analyst who once took the quiz with their work
//      address would have that quiz session claimed by logging in to a
//      dashboard. handleRequestOtp similarly self-heals users with paid orders.
//
// What remains is what actually applies: send a code, verify a code, and keep
// the brute-force guard. Rate limiting runs through SECURITY DEFINER functions
// (see 00001_baseline.sql) so it needs no elevated key.

import { createClient } from '@repo/shared/supabase/server';
import { isCroAnalyst } from './cro-auth';

export interface RateLimitVerdict {
  allowed: boolean;
  reason?: string;
  retryAfterMinutes?: number;
}

export async function checkCroOtpRateLimit(email: string): Promise<RateLimitVerdict> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_check_otp_rate_limit', {
    p_email: email,
  });
  if (error) {
    // Fail OPEN, matching the shared limiter: a database hiccup must not lock
    // the team out of their own dashboard. The allowlist is still the real gate.
    console.error('[cro-otp] rate-limit check failed:', error.message);
    return { allowed: true };
  }
  // Narrowed rather than cast: the RPC returns jsonb, which the generated types
  // widen to `Json` (arrays and scalars included). A blind cast would turn an
  // unexpected shape into a lockout that only reproduces in production.
  if (data && typeof data === 'object' && !Array.isArray(data) && 'allowed' in data) {
    const verdict = data as { allowed?: unknown; reason?: unknown; retryAfterMinutes?: unknown };
    return {
      allowed: verdict.allowed !== false,
      reason: typeof verdict.reason === 'string' ? verdict.reason : undefined,
      retryAfterMinutes:
        typeof verdict.retryAfterMinutes === 'number' ? verdict.retryAfterMinutes : undefined,
    };
  }
  return { allowed: true };
}

export async function recordCroOtpAttempt(
  email: string,
  success: boolean,
  ipAddress: string | null,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('cro_record_otp_attempt', {
    p_email: email,
    p_success: success,
    // The RPC's DEFAULT NULL is expressed as an optional arg in the generated
    // types, so an explicit null has to become undefined to omit it.
    p_ip: ipAddress ?? undefined,
  });
  if (error) console.error('[cro-otp] failed to record attempt:', error.message);
}

/**
 * Send a login code.
 *
 * `shouldCreateUser: true`, and that is deliberate even though it reads like the
 * opposite of what a staff dashboard wants. Analysts are granted access by an
 * INSERT into cro_analysts, which creates no auth user — so with `false` a newly
 * granted analyst could never complete a first login, and the failure would look
 * like a broken code rather than a missing account. Membership is still enforced
 * at verification: verifyCroOtp signs out anyone not on the list, so an auth user
 * on its own opens nothing.
 *
 * CONSEQUENCE, and it bit us: a first-time address takes GoTrue's `confirmation`
 * flow rather than `magic_link`, so BOTH templates have to render {{ .Token }}.
 * See supabase/config.toml — leaving `confirmation` stock mails a confirmation
 * link and the login dies with no error.
 */
export async function sendCroOtp(email: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) {
    console.error('[cro-otp] signInWithOtp failed:', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Verify a code, establish the session, and report whether the person is on the
 * analyst list.
 *
 * THE MEMBERSHIP CHECK RUNS ON THIS CLIENT INSTANCE, DELIBERATELY.
 *
 * The obvious shape — verify here, then call isCroAnalyst() with a fresh client
 * in the route — does not work. verifyOtp writes the session through
 * cookieStore.set, and a second createClient() in the same request reads
 * cookies(), which does not yet reflect what was just written. The membership
 * check would run unauthenticated, fail closed, and lock out every legitimate
 * analyst on their first login. This instance already holds the access token in
 * memory, so it is the only one that can answer.
 *
 * On a non-analyst the session is torn down before returning: verifying a valid
 * code must not leave a customer holding a session on the CRO domain.
 */
export async function verifyCroOtp(
  email: string,
  token: string,
): Promise<{ ok: boolean; isAnalyst: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) return { ok: false, isAnalyst: false, error: error.message };

  const isAnalyst = await isCroAnalyst(supabase);
  if (!isAnalyst) {
    await supabase.auth.signOut();
  }
  return { ok: true, isAnalyst };
}

/** Best-effort client IP from the proxy headers Vercel sets. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip');
}
