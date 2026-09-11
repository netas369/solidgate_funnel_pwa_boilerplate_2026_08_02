import { createHash } from 'node:crypto';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';

export type AdminRateLimitResult =
  | { allowed: true }
  | { allowed: false; unavailable: boolean };

export async function consumeAdminRateLimit(input: {
  subject: string;
  scope: 'admin_otp_request' | 'support_lookup' | 'support_action';
  requests: number;
  windowSeconds: number;
}): Promise<AdminRateLimitResult> {
  const subjectDigest = createHash('sha256').update(input.subject).digest('hex');
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc('consume_admin_rate_limit', {
    p_scope: input.scope,
    p_subject_digest: subjectDigest,
    p_limit: input.requests,
    p_window_seconds: input.windowSeconds,
  });

  if (error) {
    console.error('[admin/rate-limit] consume failed:', error.message);
    return { allowed: false, unavailable: true };
  }
  return data ? { allowed: true } : { allowed: false, unavailable: false };
}
