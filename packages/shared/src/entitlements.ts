import { getSupabaseAdminClient } from './supabase/admin';
import { PRICE_MAP } from './price-map';
import { PRODUCT_ID_TO_CODE } from './solidgate/catalog';
import {
  currentPaymentEnvironment,
  type PaymentEnvironment,
} from './payment-environment';

// ─── Reverse map: every per-locale product display name → PRICE_MAP slug ───
// Flattens the nested multi-currency PRICE_MAP so every localized productName
// resolves back to its slug. Preserves backwards compat with historic
// orders.product_name rows stored under an earlier code batch.
export const PRODUCT_NAME_TO_SLUG: Record<string, string> = Object.fromEntries([
  ...Object.entries(PRICE_MAP).flatMap(([slug, byCurrency]) =>
    Object.values(byCurrency).map(({ productName }) => [productName, slug] as const),
  ),
  // Solidgate writes the LOCALE-AGNOSTIC code (BRANDPDF5_000000_PDF), which no
  // per-locale name above can match. Without these entries a Solidgate buyer's
  // entitlements resolve to null and their purchased downloads never appear in
  // the PWA library. Both shapes must resolve, forever: history keeps the
  // locale-prefixed codes.
  ...Object.entries(PRODUCT_ID_TO_CODE).map(([slug, code]) => [code, slug] as const),
]);

/**
 * Resolve a product display name (from orders.product_name) back to its PRICE_MAP key.
 * Returns null if the name is not recognized.
 */
export function resolveProductSlug(productName: string): string | null {
  return PRODUCT_NAME_TO_SLUG[productName] ?? null;
}

// ─── Upsert entitlement (never throws, returns success boolean) ─────────────

interface UpsertEntitlementParams {
  userId: string;
  productSlug: string;
  accessLevel: 'full' | 'trial' | 'grace';
  orderId?: string;
  expiresAt?: string | null;
  source?: string;
  /**
   * PSP subscription id. Revocation handlers key off this, so it must be set
   * for every recurring grant and left null for one-time purchases.
   */
  solidgateSubscriptionId?: string | null;
  paymentEnvironment?: PaymentEnvironment;
}

/**
 * Idempotently grant an entitlement. Environment is part of the conflict key,
 * so a Preview purchase cannot mutate the buyer's live access row.
 *
 * Re-grant semantics: when called for a NEW successful order, resets `status`
 * to 'active' and clears `revoked_at`. Without this, the
 * past_due/revoked rows that webhook handlers write on payment failure
 * would persist across a successful re-purchase  -  the dashboard's
 * `.eq('status', 'active')` filter would still treat the row as inactive
 * and lock the UI even after a fresh charge succeeded. Every caller of
 * this helper is a GRANT event (funnel grant, OTO charge, PWA add-on
 * subscribe); webhook past_due+grace transitions use raw `supabase.from(...).upsert(...)`
 * with explicit status, so they are unaffected. The database replay trigger
 * rejects clearing a revoke tombstone with the SAME order_id, and rejects any
 * grant tied to a terminal Solidgate order. That is what keeps a stale confirm
 * URL from turning this intentionally reusable helper into a resurrection path.
 */
export async function upsertEntitlement(params: UpsertEntitlementParams): Promise<boolean> {
  try {
    const admin = getSupabaseAdminClient();
    const paymentEnvironment = params.paymentEnvironment ?? currentPaymentEnvironment();
    const { error } = await admin.from('entitlements').upsert(
      {
        payment_environment: paymentEnvironment,
        user_id: params.userId,
        product_slug: params.productSlug,
        access_level: params.accessLevel,
        order_id: params.orderId ?? null,
        expires_at: params.expiresAt ?? null,
        source: params.source ?? null,
        solidgate_subscription_id: params.solidgateSubscriptionId ?? null,
        status: 'active',
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'payment_environment,user_id,product_slug' },
    );
    if (error) {
      console.error('[entitlements] upsert failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      '[entitlements] upsert failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ─── Check single entitlement ────────────────────────────────────────────────

/**
 * Returns true if the user has an active (non-revoked, non-expired) entitlement
 * for the given product slug. Server-side only (uses admin client).
 */
export async function hasEntitlement(
  userId: string,
  productSlug: string,
  paymentEnvironment: PaymentEnvironment = currentPaymentEnvironment(),
): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from('entitlements')
    .select('id')
    .eq('payment_environment', paymentEnvironment)
    .eq('user_id', userId)
    .eq('product_slug', productSlug)
    // Honor grace window the webhook sets on payment failure (past_due+grace)
    // alongside normal active rows.
    .or('status.eq.active,and(status.eq.past_due,access_level.eq.grace)')
    .is('revoked_at', null)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    .maybeSingle();
  return !!data;
}


// ─── Member-area (app) access ────────────────────────────────────────────────

/**
 * PRICE_MAP slugs whose entitlement opens the member area itself: the main
 * subscription tiers and the lifetime replacement. Add-ons (the weekly add-on,
 * the download library) gate their own surfaces and never grant the app shell.
 */
export const APP_ACCESS_PRODUCT_SLUGS = new Set([
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'trial_monthly',
  'special_1eur',
  'special_free',
  'oto1_lifetime',
]);

export type AppAccessState = 'active' | 'revoked' | 'none';

/**
 * Solidgate UAT item 8: a hard cancel must actually end member-area access.
 *
 * 'active'  — a live (or past_due+grace) app-access entitlement exists.
 * 'revoked' — the newest app-access row is an EXPLICIT tombstone (revoked_at
 *             set or status canceled) and nothing live remains; the shell
 *             must lock.
 * 'none'    — nothing live, but no explicit tombstone governs either.
 *             Deliberately NOT treated as locked, for two races: a fresh
 *             buyer can reach the PWA while the capture webhook is still
 *             writing their first entitlement, and a paying subscriber's
 *             expires_at is written as the provider's next_charge_at with
 *             ZERO slack — between the billing instant and the renew/dunning
 *             callback their active row is momentarily lapsed. Cancel/expire
 *             always write the explicit tombstone, so hard cancels still
 *             lock. Login alone already gates the rest.
 */
export async function appAccessEntitlementState(
  userId: string,
  paymentEnvironment: PaymentEnvironment = currentPaymentEnvironment(),
): Promise<AppAccessState> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('entitlements')
    .select('product_slug, status, access_level, revoked_at, expires_at, granted_at')
    .eq('payment_environment', paymentEnvironment)
    .eq('user_id', userId);
  if (error) {
    // Fail open: this gate exists to lock cancelled buyers out, and a read
    // outage must not lock the paying ones out instead.
    console.error('[entitlements] app-access read failed:', error.message);
    return 'active';
  }
  const appRows = (data ?? []).filter((row) => {
    const slug = PRODUCT_NAME_TO_SLUG[row.product_slug ?? ''] ?? row.product_slug;
    return APP_ACCESS_PRODUCT_SLUGS.has(slug ?? '');
  });
  if (appRows.length === 0) return 'none';
  const now = Date.now();
  const live = appRows.some(
    (row) =>
      row.revoked_at == null &&
      (row.status === 'active' ||
        (row.status === 'past_due' && row.access_level === 'grace')) &&
      (row.expires_at == null || Date.parse(row.expires_at) > now),
  );
  if (live) return 'active';
  // The NEWEST row decides, so a long-dead tombstone (an old cancelled trial)
  // cannot outvote the entitlement that actually governs access today.
  const newest = appRows.reduce((a, b) =>
    (Date.parse(a.granted_at ?? '') || 0) >= (Date.parse(b.granted_at ?? '') || 0) ? a : b,
  );
  return newest.revoked_at != null || newest.status === 'canceled' ? 'revoked' : 'none';
}

// ─── Get all active entitlements for a user ──────────────────────────────────

/**
 * Returns all active (non-revoked) entitlements for a user, ordered by most recent first.
 */
export async function getUserEntitlements(
  userId: string,
  paymentEnvironment: PaymentEnvironment = currentPaymentEnvironment(),
): Promise<
  Array<{
    product_slug: string;
    access_level: string;
    granted_at: string;
    order_id: string | null;
    expires_at: string | null;
  }>
> {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from('entitlements')
    .select('product_slug, access_level, granted_at, order_id, expires_at')
    .eq('payment_environment', paymentEnvironment)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('granted_at', { ascending: false });
  return data ?? [];
}
