import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentEnvironment } from '../payment-environment';
import { promoteSessionVaultToAccount } from '../solidgate/account-vault';
import { backfillOrderEntitlement } from './entitlement-backfill';

/** Caller must prove the current browser owns this email and the payment cookie. */
export async function claimVerifiedPurchaseSession(params: {
  admin: SupabaseClient;
  userId: string;
  email: string;
  sessionId: string;
  paymentEnvironment: PaymentEnvironment;
  source?: 'claim' | 'otp_verify';
}): Promise<'claimed' | 'missing' | 'email_mismatch' | 'other_owner'> {
  const { admin, userId, sessionId, paymentEnvironment } = params;
  const email = params.email.trim().toLowerCase();
  const { data: session, error: sessionError } = await admin
    .from('sessions').select('email, user_id').eq('id', sessionId).maybeSingle();
  if (sessionError) throw new Error('Unable to read purchase session');
  if (!session) return 'missing';
  if (!session.email || session.email.trim().toLowerCase() !== email) return 'email_mismatch';
  if (session.user_id && session.user_id !== userId) return 'other_owner';

  if (!session.user_id) {
    const { error } = await admin.from('sessions').update({ user_id: userId })
      .eq('id', sessionId).is('user_id', null);
    if (error) throw new Error('Unable to link purchase session');
  }
  const claimedAt = new Date().toISOString();
  const { error: ownerError } = await admin.from('orders')
    .update({ user_id: userId, claimed_at: claimedAt })
    .eq('payment_environment', paymentEnvironment).eq('session_id', sessionId).is('user_id', null);
  if (ownerError) throw new Error('Unable to link purchased orders');

  // Workers may already have assigned user_id from checkout email. That is not
  // authentication. Only this verified browser journey records the new proof.
  const { error: proofError } = await admin.from('orders')
    .update({ claimed_at: claimedAt, auth_verified_at: claimedAt })
    .eq('payment_environment', paymentEnvironment).eq('session_id', sessionId)
    .eq('user_id', userId).eq('solidgate_customer_email', email).is('auth_verified_at', null);
  if (proofError) throw new Error('Unable to verify purchased orders');

  const { data: orders, error: ordersError } = await admin.from('orders')
    .select('id, psp, product_name, product_slug, status, created_at, amount_cents, solidgate_original_amount_cents, solidgate_subscription_id')
    .eq('payment_environment', paymentEnvironment).eq('session_id', sessionId)
    .eq('user_id', userId).in('status', ['completed', 'trialing']);
  if (ordersError) throw new Error('Unable to read purchased orders');
  for (const order of orders ?? []) {
    await backfillOrderEntitlement({ admin, order, userId, paymentEnvironment, source: params.source ?? 'claim' });
  }
  // A token may still be waiting on the signed provider callback. The durable
  // marker lets that callback promote later without blocking verified login.
  await promoteSessionVaultToAccount(admin, { userId, sessionId, paymentEnvironment })
    .catch((error) => console.error('[auth/verified-claim] vault promotion deferred:', error));
  return 'claimed';
}
