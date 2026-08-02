// Post-payment account provisioning.
//
// Everything that happens once money is recognised. Access/auth work stays on
// the redirect path; the welcome email and any slow profile enrichment are
// executed by the durable Solidgate fulfillment worker.
//
// The access grant reports a boolean to the request. Enrichment throws on a
// retryable failure, but it runs only under a claim-fenced worker and therefore
// can never hold the paid redirect open.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { createClient } from '@repo/shared/supabase/server';
import { upsertEntitlement } from '@repo/shared/entitlements';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { routing } from '@repo/i18n/routing';

type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>;

export interface SessionRow {
  email: string | null;
  user_id: string | null;
  locale: string | null;
  quiz_answers: unknown;
}

/** Which orders row to backfill with user_id once the auth user exists. */
export interface OrderMatch {
  column: 'solidgate_order_id';
  value: string;
}

function isExistingUserError(
  error: { message?: string | null; status?: number | null; code?: string | null } | null,
): boolean {
  if (!error) return false;
  // Prefer error.code — GoTrue returns stable codes regardless of message
  // wording, which has changed between versions and broken message-only regexes.
  const code = error.code ?? null;
  if (code === 'email_exists' || code === 'user_already_exists') return true;
  const message = error.message?.toLowerCase() ?? '';
  return (
    error.status === 422 &&
    /already\s+(?:been\s+)?registered|already\s+exists|duplicate/.test(message)
  );
}

/**
 * Creates (or resolves) the auth user for a purchase and logs the browser in,
 * by minting a magic link server-side and redeeming it through the SSR client.
 * Best-effort: never throws, returns linked=false on any failure.
 */
export async function linkAuthUser(params: {
  email: string;
  sessionId: string;
  userId: string | null;
  orderMatch: OrderMatch;
  supabaseAdmin: SupabaseAdmin;
  logPrefix: string;
}): Promise<{ linked: boolean; userId: string | null; isNewUser: boolean }> {
  const { email, sessionId, userId, orderMatch, supabaseAdmin, logPrefix } = params;
  let resolvedUserId = userId;
  let isNewUser = false;

  if (!resolvedUserId) {
    const { data: createdUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createUserError && !isExistingUserError(createUserError)) {
      console.error(`${logPrefix} auth createUser failed:`, createUserError.message);
      return { linked: false, userId: resolvedUserId, isNewUser };
    }
    resolvedUserId = createdUser?.user?.id ?? null;
    if (resolvedUserId) isNewUser = true;
  }

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !linkData?.properties.hashed_token) {
    console.error(`${logPrefix} auth generateLink failed:`, linkError?.message ?? 'missing hash');
    return { linked: false, userId: resolvedUserId, isNewUser };
  }
  resolvedUserId = resolvedUserId ?? linkData.user.id;

  // SSR client is instantiated here, not at module scope: it binds to this
  // request's cookies, which is what logs the buyer's browser in.
  const ssrClient = await createClient();
  const { error: verifyError } = await ssrClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'email',
  });
  if (verifyError) {
    console.error(`${logPrefix} auth verifyOtp failed:`, verifyError.message);
    return { linked: false, userId: resolvedUserId, isNewUser };
  }

  const { error: sessionUpdateError } = await supabaseAdmin
    .from('sessions')
    .update({ user_id: resolvedUserId })
    .eq('id', sessionId);
  if (sessionUpdateError) {
    console.error(`${logPrefix} auth session update failed:`, sessionUpdateError.message);
    return { linked: false, userId: resolvedUserId, isNewUser };
  }

  const { error: orderUserIdError } = await supabaseAdmin
    .from('orders')
    .update({ user_id: resolvedUserId, claimed_at: new Date().toISOString() })
    .eq('payment_environment', currentPaymentEnvironment())
    .eq(orderMatch.column, orderMatch.value)
    .is('user_id', null);
  if (orderUserIdError) {
    console.error(`${logPrefix} orders user_id update failed:`, orderUserIdError.message);
  }

  return { linked: true, userId: resolvedUserId, isNewUser };
}

/**
 * Redirect-critical access grant. Customer email and member-area enrichment are
 * deliberately absent; the caller persists those as independent outbox jobs.
 */
export async function provisionPurchasedAccount(params: {
  userId: string | null;
  orderId: string | null;
  /** The offering code (e.g. BRAND_000000_SUB), never the internal tier slug. */
  productSlug: string | null;
  expiresAt: string | null;
  /**
   * Solidgate subscription id. Revocation handlers key off it, so pass it for
   * every recurring grant and leave it null for one-time purchases.
   */
  subscriptionId: string | null;
  source: string;
}): Promise<{ entitlementGranted: boolean }> {
  const { userId, orderId, productSlug, expiresAt, subscriptionId, source } = params;
  const paymentEnvironment = currentPaymentEnvironment();

  let entitlementGranted = false;
  if (productSlug && userId) {
    entitlementGranted = await upsertEntitlement({
      userId,
      productSlug,
      accessLevel: 'full',
      orderId: orderId ?? undefined,
      expiresAt,
      source,
      solidgateSubscriptionId: subscriptionId,
      paymentEnvironment,
    });
  }

  return { entitlementGranted };
}

/**
 * Retryable member-area enrichment, executed only by the durable outbox worker
 * (the `enrich_main_profile` effect).
 *
 * This is the extension point for slow post-purchase work that must not hold
 * the paid redirect open: seeding a profile from the quiz answers, kicking off
 * a generated report, calling an internal PWA provisioning endpoint, and so on.
 *
 * Contract with the worker:
 *  - Return normally for a valid no-op (e.g. the quiz captured nothing usable).
 *  - THROW on a retryable failure — the claim-fenced worker will back off and
 *    retry, and a permanently-failing job is parked for manual review. Never
 *    swallow a database error here or the buyer silently gets a half-set-up
 *    account with no trace.
 *  - Assume AT-LEAST-ONCE delivery: everything below must be idempotent.
 */
export async function enrichPurchasedAccount(params: {
  supabase: SupabaseAdmin;
  sessionId: string;
  session: SessionRow;
  userId: string;
  logPrefix: string;
}): Promise<void> {
  const { supabase, session, userId } = params;

  // TODO(new product): product-specific post-purchase enrichment goes here.
  // `params.sessionId`, `session.quiz_answers` and `params.logPrefix` are
  // threaded through for exactly that purpose.

  // Funnel locale → user_prefs, so the PWA can hydrate NEXT_LOCALE. Never
  // clobber a choice the user later made in the member-area language switcher.
  if (session.locale && (routing.locales as readonly string[]).includes(session.locale)) {
    const { error: prefsError } = await supabase.from('user_prefs').upsert(
      {
        user_id: userId,
        locale: session.locale,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id', ignoreDuplicates: true },
    );
    if (prefsError) throw new Error(`user_prefs upsert failed: ${prefsError.message}`);
  }
}
