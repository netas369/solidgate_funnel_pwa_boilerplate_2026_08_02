import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME, verifyPaymentCookie } from '../payment-cookie';
import { getSupabaseAdminClient } from '../supabase/admin';
import { createClient } from '../supabase/server';
import { promoteSessionVaultToAccount } from '../solidgate/account-vault';
import { currentPaymentEnvironment } from '../payment-environment';
import { backfillOrderEntitlement } from './entitlement-backfill';

function isExistingUserError(error: { message?: string | null; status?: number | null } | null) {
  if (!error) return false;
  const message = error.message?.toLowerCase() ?? '';
  return error.status === 422 && /already registered|already exists|duplicate/.test(message);
}

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

    // If already linked, return success immediately
    if (session.user_id) {
      await promoteSessionVaultToAccount(admin, {
        userId: session.user_id,
        sessionId: verified.sessionId,
        paymentEnvironment,
      }).catch((err) => console.error('[auth/claim-purchase] vault promote failed:', err));
      return NextResponse.json({ ok: true, authLinked: true });
    }

    // Step 1: Create user (idempotent -- 422 duplicate is handled below)
    let resolvedUserId: string | null = null;
    const { data: createdUser, error: createUserError } =
      await admin.auth.admin.createUser({
        email: session.email,
        email_confirm: true,
      });

    if (createUserError && !isExistingUserError(createUserError)) {
      console.error('[auth/claim-purchase] createUser failed:', createUserError.message);
      return NextResponse.json({ ok: true, authLinked: false });
    }

    resolvedUserId = createdUser?.user?.id ?? null;

    // Step 2: Generate magic link token (works for both new and existing users)
    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({
        type: 'magiclink',
        email: session.email,
      });

    if (linkError || !linkData?.properties.hashed_token) {
      console.error(
        '[auth/claim-purchase] generateLink failed:',
        linkError?.message ?? 'missing hash',
      );
      return NextResponse.json({ ok: true, authLinked: false });
    }

    resolvedUserId = resolvedUserId ?? linkData.user.id;

    // Step 3: Verify OTP via SSR client (creates browser auth session)
    const ssrClient = await createClient();
    const { error: verifyError } = await ssrClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'email',
    });

    if (verifyError) {
      console.error('[auth/claim-purchase] verifyOtp failed:', verifyError.message);
      return NextResponse.json({ ok: true, authLinked: false });
    }

    // Step 4: Link CURRENT session only (D-02: no global backfill)
    await admin
      .from('sessions')
      .update({ user_id: resolvedUserId })
      .eq('id', verified.sessionId);

    // Step 5: Set claimed_at on orders belonging to this session only
    await admin
      .from('orders')
      .update({ user_id: resolvedUserId, claimed_at: new Date().toISOString() })
      .eq('payment_environment', paymentEnvironment)
      .eq('session_id', verified.sessionId)
      .is('user_id', null);

    // Phase 1007: Create entitlements for claimed orders (D-09)
    const { data: claimedOrders } = await admin
      .from('orders')
      .select(
        'id, psp, product_name, product_slug, status, created_at, amount_cents, solidgate_original_amount_cents, solidgate_subscription_id',
      )
      .eq('payment_environment', paymentEnvironment)
      .eq('session_id', verified.sessionId)
      .eq('user_id', resolvedUserId)
      .in('status', ['completed', 'trialing']);

    if (claimedOrders) {
      for (const order of claimedOrders) {
        await backfillOrderEntitlement({
          admin,
          order,
          userId: resolvedUserId!,
          paymentEnvironment,
          source: 'claim',
        });
      }
    }

    // Follow the card: the funnel vaulted it against the session; a claimed
    // purchase moves it to the account so the member area keeps one-click.
    await promoteSessionVaultToAccount(admin, {
      userId: resolvedUserId!,
      sessionId: verified.sessionId,
      paymentEnvironment,
    }).catch((err) => console.error('[auth/claim-purchase] vault promote failed:', err));

    return NextResponse.json({ ok: true, authLinked: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[auth/claim-purchase] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
