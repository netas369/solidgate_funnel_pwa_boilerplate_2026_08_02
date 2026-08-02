import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@repo/shared/supabase/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { verifyPaymentCookie, PAYMENT_COOKIE_NAME } from '@repo/shared/payment-cookie';
import { SuccessClient } from '@/features/success/components/success-client';
import { getUserEntitlements } from '@repo/shared/entitlements';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';

/**
 * /success — an optional order-confirmation page.
 *
 * NOTE: the live funnel does not route here. OTO8's exit CTA goes to
 * /dashboard, which relays a magic link into the PWA. Keep this page as a
 * scaffold (or wire it into your flow), but do not assume buyers see it.
 *
 * Three tiers of recovery, in order: an authenticated user, a valid payment
 * cookie, then a bounce back to /offer. Both order queries are scoped by
 * payment_environment so test-mode purchases never leak into a live summary.
 */
export default async function SuccessRoute() {
  const paymentEnvironment = currentPaymentEnvironment();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Tier 1: Authenticated user  -  load orders by user_id + entitlements enrichment (D-06).
  if (user?.id && user.email) {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, product_name, product_slug, amount_cents, currency, status')
      .eq('payment_environment', paymentEnvironment)
      .eq('user_id', user.id)
      .in('status', ['completed', 'trialing'])
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to load orders: ${error.message}`);
    }

    const orderList = orders ?? [];

    // Ownership display. Entitlements are locale-agnostic; never gate UI on a
    // localized product_name.
    const entitlements = await getUserEntitlements(user.id);

    return (
      <SuccessClient orders={orderList} email={user.email} entitlements={entitlements} />
    );
  }

  // Tier 2: no auth session, but a valid payment cookie — recover by session_id.
  const cookieStore = await cookies();
  const paymentCookie = cookieStore.get(PAYMENT_COOKIE_NAME)?.value;
  const cookieData = paymentCookie ? await verifyPaymentCookie(paymentCookie) : null;

  if (cookieData?.sessionId) {
    const adminClient = getSupabaseAdminClient();
    const { data: orders, error } = await adminClient
      .from('orders')
      .select('id, product_name, product_slug, amount_cents, currency, status')
      .eq('payment_environment', paymentEnvironment)
      .eq('session_id', cookieData.sessionId)
      .in('status', ['completed', 'trialing'])
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[success] cookie-based order lookup failed:', error.message);
    } else {
      const orderList = orders ?? [];

      return <SuccessClient orders={orderList} email={null} />;
    }
  }

  // Tier 3: no auth and no usable cookie — nothing to show here.
  redirect('/offer');
}
