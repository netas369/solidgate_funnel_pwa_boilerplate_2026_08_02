import { redirect } from "next/navigation";
import { createClient } from "@repo/shared/supabase/server";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { routing } from "@repo/i18n/routing";

export default async function DashboardRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // The member dashboard lives in the PWA app, on its own domain. This route
  // is the handoff: it mints a one-time magic link so the buyer lands already
  // signed in instead of being asked for a password they never set.
  // Dev default: the PWA runs on port 3206 in this boilerplate.
  const pwaUrl = process.env.NEXT_PUBLIC_PWA_URL || "http://localhost:3206";

  // Check if user is authenticated on the funnel side
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.error("[funnel/dashboard] no authenticated user  -  falling back to PWA login");
  } else if (!user.email || !user.email_confirmed_at) {
    console.error("[funnel/dashboard] authenticated user has no email", { userId: user.id });
  } else {
    // Relay only the already verified authenticated session to the PWA
    const admin = getSupabaseAdminClient();
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: user.email,
    });

    if (linkError) {
      console.error("[funnel/dashboard] generateLink failed:", {
        message: linkError.message,
        status: linkError.status,
      });
    } else if (!linkData?.properties?.hashed_token) {
      console.error("[funnel/dashboard] generateLink returned no hashed_token", {
        hasUser: !!linkData?.user,
      });
    } else {
      // Redirect to PWA with auth_token + locale for cross-origin session relay
      const url = new URL("/dashboard", pwaUrl);
      url.searchParams.set("auth_token", linkData.properties.hashed_token);
      // Always pass the locale explicitly so the PWA can lock it on first entry,
      // even for the default ('en') locale (per I18N-LOCK-01).
      if (locale && (routing.locales as readonly string[]).includes(locale)) {
        url.searchParams.set("locale", locale);
      }
      redirect(url.toString());
    }
  }

  // Fallback: no user or token generation failed  -  PWA will handle
  // (dev bypass or /login redirect)
  const safeLocale =
    locale && (routing.locales as readonly string[]).includes(locale) ? locale : "en";
  const fallbackUrl = `${pwaUrl}/dashboard?locale=${safeLocale}`;
  redirect(fallbackUrl);
}
