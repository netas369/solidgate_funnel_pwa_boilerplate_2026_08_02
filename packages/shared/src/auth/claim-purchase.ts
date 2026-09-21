import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME, verifyPaymentCookie } from '../payment-cookie';
import { getSupabaseAdminClient } from '../supabase/admin';
import { createClient } from '../supabase/server';
import { claimVerifiedPurchaseSession } from './claim-verified-session';
import { currentPaymentEnvironment } from '../payment-environment';

export async function handleClaimPurchase(): Promise<Response> {
  try {
    const paymentEnvironment = currentPaymentEnvironment();
    // Authorize via payment cookie (D-02)
    const cookieStore = await cookies();
    const signedCookie = cookieStore.get(PAYMENT_COOKIE_NAME)?.value;
    const verified = signedCookie ? await verifyPaymentCookie(signedCookie) : null;

    if (!verified) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdminClient();

    // Load session to get email and current user_id
    const { data: session, error: sessionError } = await admin
      .from('sessions')
      .select('email, user_id')
      .eq('id', verified.sessionId)
      .maybeSingle();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    if (!session.email) {
      return NextResponse.json({ error: 'No email on session' }, { status: 400 });
    }

    // A payment cookie authorizes this purchase journey, never an account
    // login. Require email ownership proven by Supabase before any account or
    // vault mutation, even when the checkout was already linked by a worker.
    const ssrClient = await createClient();
    const { data: auth, error: authError } = await ssrClient.auth.getUser();
    const user = auth?.user;
    if (authError || !user?.email_confirmed_at ||
      user.email?.trim().toLowerCase() !== session.email.trim().toLowerCase()) {
      return NextResponse.json({
        ok: true, authLinked: false, verificationRequired: true, redirectTo: '/auth/login',
      });
    }
    if (session.user_id && session.user_id !== user.id) {
      return NextResponse.json({ error: 'Purchase belongs to another account' }, { status: 403 });
    }
    const result = await claimVerifiedPurchaseSession({
      admin, userId: user.id, email: user.email!, sessionId: verified.sessionId, paymentEnvironment,
    });
    if (result !== 'claimed') {
      return NextResponse.json({ error: 'Unable to claim this purchase' }, { status: 403 });
    }

    return NextResponse.json({ ok: true, authLinked: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[auth/claim-purchase] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
