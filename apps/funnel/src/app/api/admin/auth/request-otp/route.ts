import { NextResponse } from 'next/server';
import { readSameOriginAdminJson } from '@repo/admin-core/request';
import { handleRequestOtp } from '@repo/shared/auth/request-otp';
import { isAdminEmail } from '@/app/admin/_queries/_shared';
import { consumeAdminRateLimit } from '@/features/admin/rate-limit';
import { adminConfig } from '@/admin.config';

const MAX_BODY_BYTES = 2_048;

const GENERIC_SUCCESS = {
  ok: true,
  message:
    'If that email is on the admin allowlist, check your inbox for a 6-digit code.',
};

export async function POST(request: Request) {
  const parsed = await readSameOriginAdminJson(request.clone(), MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'Invalid admin authentication request.' }, { status: parsed.status });
  }
  const body = parsed.body;
  const email =
    typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : null;

  if (!email || !isAdminEmail(email)) {
    // D-03 pre-send filter: do NOT call signInWithOtp, do NOT send email.
    return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
  }

  const rateLimit = await consumeAdminRateLimit({
    subject: email,
    scope: 'admin_otp_request',
    ...adminConfig.authentication.otpRequestRateLimit,
  });
  if (!rateLimit.allowed) {
    // Preserve allowlist enumeration resistance while failing closed when the
    // throttle store is unavailable or the address has reached its limit.
    return NextResponse.json(GENERIC_SUCCESS, { status: 200 });
  }

  return handleRequestOtp(request);
}
