import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { routing } from "@repo/i18n/routing";
import { resolveSessionUserId } from "@/lib/session";

/**
 * Per-user display preferences: routing locale and (optional) country.
 * Read by the locale switcher and by proxy.ts when picking a locale for a
 * signed-in member.
 */

const COUNTRY_RE = /^[A-Z]{2}$/;

export async function GET() {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("user_prefs")
    .select("locale, country")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    locale: data?.locale ?? null,
    country: data?.country ?? null,
  });
}

export async function PATCH(request: Request) {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { locale?: unknown; country?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const update: {
    locale?: string;
    country?: string | null;
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

  const admin = getSupabaseAdminClient();

  if (update.locale === undefined && update.country === undefined) {
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select("locale, country")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    locale: data.locale,
    country: data.country,
  });
}
