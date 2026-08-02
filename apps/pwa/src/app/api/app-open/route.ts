import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { routing } from "@repo/i18n/routing";
import { resolveSessionUserId } from "@/lib/session";

/**
 * App-open beacon. The client fires this once per idle window (not per
 * navigation), so it counts real app-opens rather than auth logins — member
 * sessions persist for a long time, so "logged in" is not "opened the app".
 *
 * Returns the fresh counters so the client can pace an in-app upsell against
 * them (see TrialPromoGate). Promo-seen counting lives client-side: the
 * baseline schema has no promo column, and adding one is a per-product choice.
 */

export const dynamic = "force-dynamic";

type AppOpenRow = {
  app_open_count: number;
  last_active_at: string | null;
};

export async function POST() {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("bump_user_app_open", {
    p_user_id: userId,
    p_default_locale: routing.defaultLocale,
  });
  if (error) {
    console.error("[app-open] bump failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const row = (Array.isArray(data) ? data[0] : data) as AppOpenRow | null;

  return NextResponse.json({
    appOpenCount: row?.app_open_count ?? null,
    lastActiveAt: row?.last_active_at ?? null,
  });
}
