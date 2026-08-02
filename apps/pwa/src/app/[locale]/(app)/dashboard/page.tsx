import { createClient } from "@repo/shared/supabase/server";
import { hasEntitlement } from "@repo/shared/entitlements";
import { resolveProductPrice, type Locale } from "@repo/shared/price-map";
import { formatPrice } from "@repo/shared/format-price";
import { PRODUCT_ID_TO_CODE, PRODUCT_ID_TO_DISPLAY_NAME } from "@repo/shared/solidgate/catalog";
import { routing } from "@repo/i18n/routing";
import { DashboardShell } from "./_components/DashboardShell";
import { PWA_SUBSCRIPTION_PRODUCT } from "@/lib/pwa-products";

/**
 * Member-area entry point.
 *
 * Deliberately thin: resolve the session, read ONE entitlement flag, resolve
 * the two prices the shell shows, render. Any product data loading belongs in
 * the tab that needs it, not here — a slow load in this file blocks the whole
 * shell from painting.
 *
 * The (app) layout above has already enforced access (revoked-entitlement lock
 * + grace banner), so this page can assume the user is allowed in.
 */

/** The one-time product the Library tab offers as a purchase example. */
const DEMO_ONE_TIME_PRODUCT = "oto4_pdf" as const;

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const accountEmail = user?.email ?? "";

  // Entitlements are keyed by the OFFERING CODE the confirm route writes
  // (PRODUCT_ID_TO_CODE), not by the internal slug. Exact match, never a
  // pattern: a LIKE on a brand substring silently unlocks the wrong product
  // the day someone adds a code that happens to contain it.
  const hasPremium = user?.id
    ? await hasEntitlement(user.id, PRODUCT_ID_TO_CODE[PWA_SUBSCRIPTION_PRODUCT])
    : false;

  const priceLocale: Locale = (routing.locales as readonly string[]).includes(locale)
    ? (locale as Locale)
    : "en";

  const upsell = resolveProductPrice(PWA_SUBSCRIPTION_PRODUCT, priceLocale);
  const upsellPrice = formatPrice(upsell.amountCents, upsell.currency, priceLocale);

  const oneTime = resolveProductPrice(DEMO_ONE_TIME_PRODUCT, priceLocale);

  return (
    <DashboardShell
      accountEmail={accountEmail}
      hasPremium={hasPremium}
      upsellPrice={upsellPrice}
      oneTimeItem={{
        slug: DEMO_ONE_TIME_PRODUCT,
        label: PRODUCT_ID_TO_DISPLAY_NAME[DEMO_ONE_TIME_PRODUCT],
        price: formatPrice(oneTime.amountCents, oneTime.currency, priceLocale),
      }}
    />
  );
}
