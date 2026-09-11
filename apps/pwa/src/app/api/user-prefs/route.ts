import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { routing } from "@repo/i18n/routing";
import { resolveSessionUserId } from "@/lib/session";

/**
 * Reusable per-user preferences: locale, country, display identity,
 * notifications, and timezone.
 * Read by the locale switcher and by proxy.ts when picking a locale for a
 * signed-in member.
 */

const COUNTRY_RE = /^[A-Z]{2}$/;

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("user_prefs")
    .select("locale, country, display_name, notifications_enabled, timezone")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    locale: data?.locale ?? null,
    country: data?.country ?? null,
    displayName: data?.display_name ?? null,
    notificationsEnabled: data?.notifications_enabled ?? false,
    timezone: data?.timezone ?? null,
  });
}

export async function PATCH(request: Request) {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: {
    locale?: unknown;
    country?: unknown;
    displayName?: unknown;
    notificationsEnabled?: unknown;
    timezone?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const update: {
    locale?: string;
    country?: string | null;
    display_name?: string | null;
    notifications_enabled?: boolean;
    notifications_updated_at?: string;
    timezone?: string | null;
  } = {};

  if (typeof body.locale === "string") {
    if (!(routing.locales as readonly string[]).includes(body.locale)) {
      return NextResponse.json({ error: "invalid_locale" }, { status: 400 });
    }
    update.locale = body.locale;
  }

  if (body.country !== undefined) {
    if (body.country === null) {
      update.country = null;
    } else if (typeof body.country === "string" && COUNTRY_RE.test(body.country)) {
      update.country = body.country;
    } else {
      return NextResponse.json({ error: "invalid_country" }, { status: 400 });
    }
  }

  if (body.displayName !== undefined) {
    if (body.displayName === null) {
      update.display_name = null;
    } else if (typeof body.displayName === "string") {
      const displayName = body.displayName.trim();
      if (!displayName || displayName.length > 100) {
        return NextResponse.json({ error: "invalid_display_name" }, { status: 400 });
      }
      update.display_name = displayName;
    } else {
      return NextResponse.json({ error: "invalid_display_name" }, { status: 400 });
    }
  }

  if (body.notificationsEnabled !== undefined) {
    if (typeof body.notificationsEnabled !== "boolean") {
      return NextResponse.json({ error: "invalid_notifications_enabled" }, { status: 400 });
    }
    update.notifications_enabled = body.notificationsEnabled;
    update.notifications_updated_at = new Date().toISOString();
  }

  if (body.timezone !== undefined) {
    if (body.timezone === null) {
      update.timezone = null;
    } else if (typeof body.timezone === "string") {
      const timezone = body.timezone.trim();
      if (!timezone || timezone.length > 100 || !isValidTimezone(timezone)) {
        return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
      }
      update.timezone = timezone;
    } else {
      return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
    }
  }

  const admin = getSupabaseAdminClient();

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  // Read existing row so we can satisfy the NOT NULL locale on insert
  // when only country is being patched for a brand-new user.
  const { data: existing } = await admin
    .from("user_prefs")
    .select("locale")
    .eq("user_id", userId)
    .maybeSingle();

  const localeForUpsert =
    update.locale ?? existing?.locale ?? routing.defaultLocale;

  const { data, error } = await admin
    .from("user_prefs")
    .upsert(
      {
        user_id: userId,
        locale: localeForUpsert,
        ...(update.country !== undefined ? { country: update.country } : {}),
        ...(update.display_name !== undefined ? { display_name: update.display_name } : {}),
        ...(update.notifications_enabled !== undefined
          ? {
              notifications_enabled: update.notifications_enabled,
              notifications_updated_at: update.notifications_updated_at,
            }
          : {}),
        ...(update.timezone !== undefined ? { timezone: update.timezone } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select("locale, country, display_name, notifications_enabled, timezone")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    locale: data.locale,
    country: data.country,
    displayName: data.display_name,
    notificationsEnabled: data.notifications_enabled,
    timezone: data.timezone,
  });
}
