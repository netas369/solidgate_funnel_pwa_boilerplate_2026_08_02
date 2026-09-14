// server-only — never import from a 'use client' file.
// Consumed by: proxy.ts, /api/auth/verify-otp, and the dashboard layout.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@repo/shared/types/database';

/**
 * Is the CURRENT caller on the CRO analyst list?
 *
 * `public.cro_analysts` is what this app checks, and every read path goes
 * through it. It is NOT where individual access is decided any more: the table
 * holds one seeded row — the shared PMC Hub identity (00001_baseline.sql) — and
 * which PEOPLE may open a board is a PMC Hub role, in a different repo.
 *
 * That is worth knowing before you debug an access problem here. A person who
 * cannot get in has almost certainly not been refused by this function; they
 * have been refused by PMC Hub, or they are trying to sign in directly with
 * their own address, which was never on the list.
 *
 * The check itself is unchanged and must stay that way. The shared-identity
 * design works precisely because no security code moved — the address simply is
 * on the list. A second row is still supported, and is how you would grant
 * someone direct access without going through the hub.
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
