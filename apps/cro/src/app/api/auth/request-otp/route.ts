import { NextResponse } from 'next/server';
import { checkCroOtpRateLimit, sendCroOtp } from '@/lib/cro-otp';
import { OTP_LENGTH } from '@repo/shared/auth/otp-length';

/**
 * Always the same answer, whoever asks. Anything else turns this endpoint into
 * an oracle for "who works on this team", which is where a targeted phish
 * starts.
 */
const GENERIC_SUCCESS = {
  ok: true,
  message: `If that email can access this dashboard, check your inbox for an ${OTP_LENGTH}-digit code.`,
};

/**
 * No allowlist here, deliberately.
 *
 * There used to be a CRO_EMAILS pre-send filter, on the theory that it stopped
 * someone making Supabase mail login codes to strangers. It did not: apps/pwa
 * and apps/funnel both call handleRequestOtp with no filter at all, so that
 * capability is already open on two public apps in this same Supabase project.
 * The filter's only real effect was to require a production deploy to onboard a
 * colleague.
 *
 * Access is decided at verification (and on every subsequent request) against
 * public.cro_analysts. Sending a code to someone who is not on that list gives
 * them a code that opens nothing.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;

  if (!email || !email.includes('@')) {
    return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
  }

  const limit = await checkCroOtpRateLimit(email);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${limit.retryAfterMinutes ?? 15} minutes.` },
      { status: 429 },
    );
  }

  // Failures are logged inside sendCroOtp; the caller is told nothing either way.
  await sendCroOtp(email);
  return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
}
