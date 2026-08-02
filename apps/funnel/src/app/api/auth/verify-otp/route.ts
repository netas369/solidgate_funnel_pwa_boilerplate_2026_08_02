import { handleVerifyOtp } from "@repo/shared/auth/verify-otp";
import { resolvePostLoginDestination } from "@repo/shared/auth/post-login-route";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { checkOtpRateLimit, recordOtpAttempt } from "@repo/shared/auth/otp-rate-limit";

export async function POST(request: Request) {
  return handleVerifyOtp(request, {
    getRedirectUrl: async (userId) => {
      const admin = getSupabaseAdminClient();
      const { data: linkedSession } = await admin
        .from('sessions')
        .select('last_oto_step, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .maybeSingle();

      return resolvePostLoginDestination({
        lastOtoStep: linkedSession?.last_oto_step ?? null,
        updatedAt: linkedSession?.updated_at ?? null,
      });
    },
    checkRateLimit: checkOtpRateLimit,
    recordAttempt: recordOtpAttempt,
  });
}
