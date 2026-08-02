import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";

/**
 * Resolve the authenticated user id for a member-area API route.
 *
 * Production requires a real Supabase session, full stop. Outside production a
 * developer can point every route at one seeded account by setting
 * DEV_FALLBACK_EMAIL — useful before the OTP flow is wired up locally, and
 * unreachable in a production build because of the NODE_ENV guard.
 *
 * TODO(new product): set DEV_FALLBACK_EMAIL in .env.local, or delete this
 * fallback entirely and always run through /login.
 */
export async function resolveSessionUserId(
  supabase: SupabaseClient,
): Promise<string | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) return user.id;

  if (process.env.NODE_ENV === "production") return null;
  const fallbackEmail = process.env.DEV_FALLBACK_EMAIL;
  if (!fallbackEmail) return null;

  const admin = getSupabaseAdminClient();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === fallbackEmail)?.id ?? null;
}
