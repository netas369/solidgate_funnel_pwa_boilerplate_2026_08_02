import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import {
  ANALYTICS_EVENT_KEY_PATTERN,
  analyticsDeploymentEnvironment,
  analyticsProjectKey,
} from "@repo/shared/analytics/server";
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

export async function POST(request: Request) {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { eventKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body.eventKey !== "string" ||
    !ANALYTICS_EVENT_KEY_PATTERN.test(body.eventKey.trim())
  ) {
    return NextResponse.json({ error: "invalid_event_key" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  const rpc = admin.rpc.bind(admin) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;

  const { data, error } = await rpc("record_user_app_open", {
    p_user_id: userId,
    p_default_locale: routing.defaultLocale,
    p_project_key: analyticsProjectKey(),
    p_deployment_environment: analyticsDeploymentEnvironment(),
    p_event_key: body.eventKey.trim(),
  });
  if (error) {
    console.error("[app-open] record failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const row = (Array.isArray(data) ? data[0] : data) as AppOpenRow | null;

  return NextResponse.json({
    appOpenCount: row?.app_open_count ?? null,
    lastActiveAt: row?.last_active_at ?? null,
  });
}
