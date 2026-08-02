import { handleRequestOtp } from "@repo/shared/auth/request-otp";

export async function POST(request: Request) {
  return handleRequestOtp(request);
}
