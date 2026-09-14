// server-only — never import from a 'use client' file.
// Consumed by: proxy.ts, /api/auth/verify-otp, and the dashboard layout.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@repo/shared/types/database';

/**
 * Is the CURRENT caller on the CRO analyst list?
 *
 * `public.cro_analysts` is the single source of truth for access. There is no
 * env allowlist any more: it took a production deploy to add a colleague, and it
 * was guarding a door that stands open anyway — apps/pwa and apps/funnel both
 * call handleRequestOtp with no allowlist, so "anyone can make Supabase mail a
 * login code" is already true on two public apps in this same project.
 *
 * Granting access is now one INSERT, and revoking one DELETE that takes effect
 * on the caller's next page load rather than the next deploy.
 *
 * Takes the client rather than building one, because the two call sites have
 * different ones: server components use @repo/shared/supabase/server, while
 * proxy.ts builds a request-scoped client from the incoming cookies. Passing it
 * in also lets the verify-otp route reuse the exact instance that just
 * established the session — see the note in cro-otp.ts, which is load-bearing.
 *
 * FAILS CLOSED. is_cro_analyst() is granted to `authenticated` only, so an
 * anonymous caller gets a permission error rather than `false` — and any error
 * at all, including a transient one, means no access.
 */
export async function isCroAnalyst(
  supabase: SupabaseClient<Database>,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_cro_analyst');
  if (error) return false;
  return data === true;
}
