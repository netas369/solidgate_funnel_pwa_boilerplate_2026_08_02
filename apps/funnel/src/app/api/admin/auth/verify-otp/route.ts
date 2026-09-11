import { handleVerifyOtp } from '@repo/shared/auth/verify-otp';
import { readSameOriginAdminJson } from '@repo/admin-core/request';
import { createClient } from '@repo/shared/supabase/server';
import { adminLandingPathForEmail } from '@/app/admin/_queries/_shared';
import { checkOtpRateLimit, recordOtpAttempt } from '@repo/shared/auth/otp-rate-limit';

const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request) {
  const parsed = await readSameOriginAdminJson(request.clone(), MAX_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json(
      { error: 'Invalid admin authentication request.' },
      { status: parsed.status },
    );
  }
  return handleVerifyOtp(request, {
    checkRateLimit: checkOtpRateLimit,
    recordAttempt: recordOtpAttempt,
    getRedirectUrl: async (_userId) => {
      // D-03 post-verify defense-in-depth + D-09 destination.
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return adminLandingPathForEmail(user?.email);
    },
  });
}
