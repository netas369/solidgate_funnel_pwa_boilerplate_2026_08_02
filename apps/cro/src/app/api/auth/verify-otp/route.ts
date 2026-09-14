import { NextResponse } from 'next/server';
import { clientIp, recordCroOtpAttempt, verifyCroOtp } from '@/lib/cro-otp';

/** Identical for a wrong code and for a valid code from a non-analyst. */
const REJECTED = { error: 'Invalid or expired code' };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    token?: string;
  };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
  const token = typeof body.token === 'string' ? body.token.trim() : null;

  if (!email || !token) {
    return NextResponse.json({ error: 'Email and code are required.' }, { status: 400 });
  }

  const ip = clientIp(request);
  // Verifies AND resolves membership on one client — see the note in cro-otp.ts.
  // Supabase auth is shared across all three apps, so a customer with a member
  // -area account holds a perfectly valid code; this is where that stops being
  // enough. verifyCroOtp signs them out again before returning.
  const result = await verifyCroOtp(email, token);

  // Recorded for BOTH outcomes: failures drive the lockout, successes make the
  // audit trail readable. Membership is not part of this — a real analyst
  // mistyping their code and a stranger guessing look the same to the limiter.
  await recordCroOtpAttempt(email, result.ok, ip);

  // Deliberately one response for two different failures. Distinguishing them
  // would turn this endpoint into a way to test whether an address is on the
  // team, which is the reconnaissance step of a targeted phish.
  if (!result.ok || !result.isAnalyst) {
    return NextResponse.json(REJECTED, { status: 400 });
  }

  return NextResponse.json({ ok: true, redirectTo: '/dashboard' });
}
