import { resolveProductSlug, upsertEntitlement } from '../entitlements';
import type { PaymentEnvironment } from '../payment-environment';
import { SOLIDGATE_PRODUCT_CODES } from '../solidgate/catalog';
import type { getSupabaseAdminClient } from '../supabase/admin';
import type { Database } from '../types/database';

const INITIAL_SUBSCRIPTION_ACCESS_MS = 7 * 24 * 60 * 60 * 1000;

type AdminClient = ReturnType<typeof getSupabaseAdminClient>;

export type EntitlementBackfillOrder = Pick<
  Database['public']['Tables']['orders']['Row'],
  | 'id'
  | 'psp'
  | 'product_name'
  | 'product_slug'
  | 'created_at'
  | 'amount_cents'
  | 'solidgate_original_amount_cents'
  | 'solidgate_subscription_id'
>;

interface BackfillOrderEntitlementParams {
  admin: AdminClient;
  order: EntitlementBackfillOrder;
  userId: string;
  paymentEnvironment: PaymentEnvironment;
  source: 'claim' | 'otp_verify';
}

function initialSubscriptionExpiresAt(createdAt: string): string | null {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;

  return new Date(createdAtMs + INITIAL_SUBSCRIPTION_ACCESS_MS).toISOString();
}

/**
 * Backfill access after an anonymous order is linked to an account.
 *
 * Solidgate main orders must use the same atomic grant RPC as the checkout and
 * webhook paths. In particular, a rejected (for example, older) order must not
 * fall through to the generic upsert and replace the entitlement owner.
 */
export async function backfillOrderEntitlement({
  admin,
  order,
  userId,
  paymentEnvironment,
  source,
}: BackfillOrderEntitlementParams): Promise<boolean> {
  const mainProductCode = SOLIDGATE_PRODUCT_CODES.main;
  const referencesSolidgateMain = order.psp === 'solidgate'
    && (order.product_name === mainProductCode || order.product_slug === mainProductCode);

  if (referencesSolidgateMain) {
    const amountCents = order.solidgate_original_amount_cents ?? order.amount_cents;
    const fallbackExpiresAt = initialSubscriptionExpiresAt(order.created_at);
    if (
      order.product_name !== mainProductCode
      || order.product_slug !== mainProductCode
      || !order.solidgate_subscription_id
      || !Number.isSafeInteger(amountCents)
      || amountCents < 0
      || !fallbackExpiresAt
    ) {
      return false;
    }

    const { data, error } = await admin.rpc('grant_solidgate_main_entitlement', {
      p_payment_environment: paymentEnvironment,
      p_order_id: order.id,
      p_user_id: userId,
      p_product_slug: mainProductCode,
      p_subscription_id: order.solidgate_subscription_id,
      p_amount_cents: amountCents,
      p_fallback_expires_at: fallbackExpiresAt,
    });
    if (error) {
      console.error(`[auth/${source}] Solidgate main entitlement RPC failed:`, error.message);
      return false;
    }

    return data === true;
  }

  const knownSlug = resolveProductSlug(order.product_name);
  const productSlug = order.psp === 'solidgate' && knownSlug
    ? order.product_slug
    : knownSlug;
  if (!productSlug) return false;

  const expiresAt = order.psp === 'solidgate' && order.solidgate_subscription_id
    ? initialSubscriptionExpiresAt(order.created_at) ?? undefined
    : undefined;

  return upsertEntitlement({
    userId,
    productSlug,
    accessLevel: 'full',
    orderId: order.id,
    expiresAt,
    source,
    solidgateSubscriptionId: order.solidgate_subscription_id,
    paymentEnvironment,
  });
}
