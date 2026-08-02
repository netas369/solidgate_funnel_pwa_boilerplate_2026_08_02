import { handleVerifyOtp } from '@repo/shared/auth/verify-otp';
import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '@/app/admin/_queries/_shared';
import { checkOtpRateLimit, recordOtpAttempt } from '@repo/shared/auth/otp-rate-limit';

export async function POST(request: Request) {
  return handleVerifyOtp(request, {
    checkRateLimit: checkOtpRateLimit,
    recordAttempt: recordOtpAttempt,
    getRedirectUrl: async (_userId) => {
      // D-03 post-verify defense-in-depth + D-09 destination.
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.email || !isAdminEmail(user.email)) {
        return '/';
      }
      return '/admin/dashboard';
    },
  });
}
