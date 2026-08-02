import { NextResponse } from 'next/server';
import { handleRequestOtp } from '@repo/shared/auth/request-otp';
import { isAdminEmail } from '@/app/admin/_queries/_shared';

const GENERIC_SUCCESS = {
  ok: true,
  message:
    'If that email is on the admin allowlist, check your inbox for a 6-digit code.',
};

export async function POST(request: Request) {
  const cloned = request.clone();
  const body = (await cloned.json().catch(() => ({}))) as { email?: string };
  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : null;

  if (!email || !isAdminEmail(email)) {
    // D-03 pre-send filter: do NOT call signInWithOtp, do NOT send email.
    return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
  }

  return handleRequestOtp(request);
}
