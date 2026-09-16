// Resolves the active past_due+grace subscription for a user, used by the PWA
// app shell to render the "update your card" banner. Returns null when:
//   - the user has no entitlement row matching status=past_due AND access_level=grace
//   - the row is revoked (revoked_at IS NOT NULL)
//   - the row is expired (expires_at <= now)
//   - the row is for an EXCLUDED product (see GRACE_EXCLUDED_* below)
//   - any DB error occurs (fail-closed: never surface a banner on transient errors)
//
// THE RULE: add-on subscriptions are revoked immediately on payment failure and
// must NEVER enter a grace window; only the MAIN subscription does. The same
// convention has to be honoured by the payment webhooks and by any dashboard
// "has add-on" check, or a cancelled add-on keeps the banner alive forever.

import { getSupabaseAdminClient } from './supabase/admin';
import { APP_ACCESS_PRODUCT_SLUGS, PRODUCT_NAME_TO_SLUG, resolveProductSlug } from './entitlements';
import { PRODUCT_ID_TO_DISPLAY_NAME } from './solidgate/catalog';
import { currentPaymentEnvironment } from './payment-environment';

/**
 * Offerings that never get a grace window, matched as SQL ILIKE patterns
 * against `entitlements.product_slug` (the locale-agnostic / locale-prefixed
 * company codes). TODO(new product): one array to edit per add-on.
 */
export const GRACE_EXCLUDED_SLUG_PATTERNS = ['%BRANDADDON%'];

/** The same offerings addressed by their internal PRICE_MAP slug. */
export const GRACE_EXCLUDED_SLUGS = ['oto2_addon_weekly'];

export interface ActiveGraceSubscription {
  /** The PSP subscription id the "update your card" flow acts on. */
  subscriptionId: string;
  productSlug: string;
  productName: string;
  expiresAt: string | null;
}

export async function getActiveGracePeriodSubscription(
  userId: string,
): Promise<ActiveGraceSubscription | null> {
  try {
    const admin = getSupabaseAdminClient();
    const paymentEnvironment = currentPaymentEnvironment();
    const nowIso = new Date().toISOString();

    let query = admin
      .from('entitlements')
      .select('solidgate_subscription_id, product_slug, expires_at, granted_at')
      .eq('payment_environment', paymentEnvironment)
      .eq('user_id', userId)
      .eq('status', 'past_due')
      .eq('access_level', 'grace')
      .is('revoked_at', null)
      .or('expires_at.is.null,expires_at.gt.' + nowIso);

    // Add-ons never enter a grace window. Both shapes are excluded: the code
    // convention (company code, possibly locale-prefixed) and the internal slug.
    for (const pattern of GRACE_EXCLUDED_SLUG_PATTERNS) {
      query = query.not('product_slug', 'ilike', pattern);
    }
    for (const slug of GRACE_EXCLUDED_SLUGS) {
      query = query.neq('product_slug', slug);
    }

    const { data } = await query
      .order('granted_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // No subscription id means there is nothing the card-update flow can act
    // on, so there is no banner to show.
    const subscriptionId = data?.solidgate_subscription_id ?? null;
    if (!data || !subscriptionId) return null;

    return {
      subscriptionId,
      productSlug: data.product_slug,
      // The slug IS the locale-coded productName in this codebase (the
      // subscribe/finalize routes write the same value to both). Downstream UI
      // can use it directly without a separate name lookup.
      productName: data.product_slug,
      expiresAt: data.expires_at ?? null,
    };
  } catch (err) {
    // Fail closed: never surface a banner on transient DB errors. Do NOT log
    // the user id to avoid log-scraping (T-q8u-05).
    console.error(
      '[grace-period] query failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** A billable subscription can recover after grace expires, including add-ons.
 * This does not grant access and never creates another subscription. */
export async function getRecoverableSubscription(
  userId: string, options: { mainOnly?: boolean } = {},
): Promise<ActiveGraceSubscription | null> {
  let query = getSupabaseAdminClient()
    .from('orders')
    .select('solidgate_subscription_id, product_slug, product_name')
    .eq('payment_environment', currentPaymentEnvironment())
    .eq('user_id', userId)
    .eq('psp', 'solidgate')
    .in('status', ['completed', 'trialing', 'past_due'])
    .not('solidgate_subscription_id', 'is', null);
  if (options.mainOnly) {
    const isMain = (slug: string) => APP_ACCESS_PRODUCT_SLUGS.has(slug) && slug !== 'oto1_lifetime';
    const mainProducts = [
      ...[...APP_ACCESS_PRODUCT_SLUGS].filter(isMain),
      ...Object.entries(PRODUCT_NAME_TO_SLUG).filter(([, slug]) => isMain(slug)).map(([name]) => name),
    ];
    query = query.in('product_slug', mainProducts);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Subscription recovery lookup failed: ${error.message}`);
  if (!data?.solidgate_subscription_id) return null;
  const internalSlug = resolveProductSlug(data.product_slug ?? data.product_name ?? '');
  return {
    subscriptionId: data.solidgate_subscription_id,
    productSlug: data.product_slug ?? data.product_name ?? '',
    productName: (internalSlug ? PRODUCT_ID_TO_DISPLAY_NAME[internalSlug as keyof typeof PRODUCT_ID_TO_DISPLAY_NAME] : null) ?? 'Subscription',
    expiresAt: null,
  };
}
