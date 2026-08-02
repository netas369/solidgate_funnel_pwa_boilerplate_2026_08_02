import { getSupabaseAdminClient } from '../supabase/admin';

// ─── Thresholds ───────────────────────────────────────────────────────────────
// Soft lock: 5 failures within 15 minutes → ask user to wait
const SOFT_LIMIT_FAILURES = 5;
const SOFT_WINDOW_MINUTES = 15;

// Hard lock: 10 failures within 1 hour → suggest contacting support
const HARD_LIMIT_FAILURES = 10;
const HARD_WINDOW_MINUTES = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: 'soft_lock' | 'hard_lock'; retryAfterMinutes: number };

/**
 * Check whether the given email is currently rate-limited for OTP attempts.
 * Reads from the otp_attempts table via the admin client (bypasses RLS).
 *
 * Returns { allowed: true } when under threshold.
 * Returns { allowed: false, reason, retryAfterMinutes } when locked.
 *
 * Shared by the funnel and the PWA member area so both surfaces enforce the
 * same brute-force policy against a 6-digit code (a ~1M keyspace).
 */
export async function checkOtpRateLimit(email: string): Promise<RateLimitResult> {
  const admin = getSupabaseAdminClient();
  const now = new Date();

  const hardWindowStart = new Date(now.getTime() - HARD_WINDOW_MINUTES * 60 * 1000).toISOString();

  // Fetch all failure attempts in the hard window in one query
  const { data: recentFailures, error } = await admin
    .from('otp_attempts')
    .select('attempted_at')
    .eq('email', email)
    .eq('success', false)
    .gte('attempted_at', hardWindowStart)
    .order('attempted_at', { ascending: false });

  if (error) {
    // Fail open on DB error  -  don't block the user, log it
    console.error('[otp-rate-limit] failed to query otp_attempts:', error.message);
    return { allowed: true };
  }

  const failures = recentFailures ?? [];

  // Hard lock check: >10 failures in last 60 min
  if (failures.length >= HARD_LIMIT_FAILURES) {
    return { allowed: false, reason: 'hard_lock', retryAfterMinutes: HARD_WINDOW_MINUTES };
  }

  // Soft lock check: >5 failures in last 15 min
  const softWindowStart = new Date(now.getTime() - SOFT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const recentSoftFailures = failures.filter((r) => r.attempted_at >= softWindowStart);

  if (recentSoftFailures.length >= SOFT_LIMIT_FAILURES) {
    return { allowed: false, reason: 'soft_lock', retryAfterMinutes: SOFT_WINDOW_MINUTES };
  }

  return { allowed: true };
}

/**
 * Record an OTP attempt (success or failure) for the given email.
 * Fire-and-forget  -  errors are logged but never thrown.
 */
export async function recordOtpAttempt(
  email: string,
  success: boolean,
  ipAddress: string | null,
): Promise<void> {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from('otp_attempts').insert({
    email,
    success,
    ip_address: ipAddress,
  });
  if (error) {
    console.error('[otp-rate-limit] failed to record otp_attempt:', error.message);
  }
}
