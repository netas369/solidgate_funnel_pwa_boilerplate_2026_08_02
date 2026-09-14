/**
 * How many digits a login code has, and how long it lives.
 *
 * ONE definition, because the number is otherwise written out independently in
 * the shared OTP input, the shared login page, the CRO login form and the
 * funnel's admin login form. Changing it in the Supabase dashboard alone breaks
 * every one of them, and the failure is silent in the worst way: the code
 * arrives in the inbox, the form refuses to submit it, and nothing logs an
 * error.
 *
 * KEEP IN SYNC WITH SUPABASE. GoTrue generates the code, so the dashboard is
 * the real authority and these constants only describe it:
 *
 *   Authentication → Emails → OTP length  ....... must equal OTP_LENGTH
 *   Authentication → Emails → OTP expiry  ....... must equal OTP_EXPIRY_MINUTES × 60
 *   supabase/config.toml [auth.email] otp_length / otp_expiry   (local stack)
 *
 * A mismatch fails CLOSED in both directions and neither raises: a longer code
 * from Supabase is truncated by the input and rejected as wrong, and a shorter
 * one never enables the submit button.
 */

/**
 * 6 digits — a 1-million keyspace.
 *
 * The brute-force bound is the lockout in `otp-rate-limit.ts`, not the
 * keyspace, which is why 6 is enough: an attacker never gets enough guesses for
 * extra digits to matter.
 *
 * GoTrue accepts 6–10. Past 8 the input row stops fitting a 360px phone without
 * shrinking the boxes below a comfortable tap target.
 */
export const OTP_LENGTH = 6;

/** Must equal the dashboard's OTP expiry ÷ 60, and the email template's wording. */
export const OTP_EXPIRY_MINUTES = 60;

/** Matches a well-formed code. Anchored, digits only — never a loose length check. */
export const OTP_TOKEN_PATTERN = new RegExp(`^\\d{${OTP_LENGTH}}$`);

/** True when `value` is a complete, well-formed code. */
export function isCompleteOtp(value: string): boolean {
  return OTP_TOKEN_PATTERN.test(value);
}

/**
 * "a" or "an" for a digit count.
 *
 * The CRO board shipped saying "an 6-digit code". The article depends on how
 * the NUMERAL is read aloud rather than on its first letter — 8 is "an eight",
 * 6 is "a six" — so it cannot be hardcoded beside a constant a product may
 * change. GoTrue accepts 6-10, and 8 is the one that flips it.
 */
export function otpArticle(n: number = OTP_LENGTH): 'a' | 'an' {
  return String(n).startsWith('8') ? 'an' : 'a';
}
