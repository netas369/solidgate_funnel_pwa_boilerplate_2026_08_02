import { handleVerifyOtp } from "@repo/shared/auth/verify-otp";
import { checkOtpRateLimit, recordOtpAttempt } from "@repo/shared/auth/otp-rate-limit";

export async function POST(request: Request) {
  return handleVerifyOtp(request, {
    // Brute-force protection against the 6-digit code (~1M keyspace): the same
    // otp_attempts-backed soft/hard lockout the funnel enforces. Without this a
    // caller could grind codes for a known member email.
    checkRateLimit: checkOtpRateLimit,
    recordAttempt: recordOtpAttempt,
    getRedirectUrl: async () => '/dashboard',
  });
}
