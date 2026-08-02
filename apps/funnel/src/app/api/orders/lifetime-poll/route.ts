import { NextResponse } from 'next/server';
import { createClient } from '@repo/shared/supabase/server';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';

// Lifetime OTO orders store the Solidgate product CODE as their slug — NOT the
// internal ProductId. Matching on the internal slug here found nothing and the
// success page silently never reconciled a lifetime purchase.
const LIFETIME_PRODUCT_SLUG = SOLIDGATE_PRODUCT_CODES.lifetime;

/**
 * GET /api/orders/lifetime-poll
 *
 * Polls for a completed lifetime order row for the authenticated user. Used by
 * SuccessClient to reconcile the optimistic UI row once the Solidgate webhook
 * has written the real row to the DB.
 *
 * Returns:
 *   { found: true,  order: { id, product_name, product_slug, amount_cents, currency } }  -  row is in DB
 *   { found: false }                                                         -  not yet / never
 *   401  -  unauthenticated
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, product_name, product_slug, amount_cents, currency')
    .eq('payment_environment', currentPaymentEnvironment())
    .eq('user_id', user.id)
    .eq('product_slug', LIFETIME_PRODUCT_SLUG)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[orders/lifetime-poll] query error:', error.message);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  if (!order) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    order: {
      id: order.id,
      product_name: order.product_name,
      product_slug: order.product_slug ?? LIFETIME_PRODUCT_SLUG,
      amount_cents: order.amount_cents,
      currency: order.currency,
    },
  });
}
