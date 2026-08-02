import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME, verifyPaymentCookie } from './payment-cookie';
import { createClient } from './supabase/server';
import { getSupabaseAdminClient } from './supabase/admin';
import { currentPaymentEnvironment } from './payment-environment';

// Gate for session-scoped payment reads (e.g. the OTO-8 order summary):
// the caller must prove they own the session's purchases, either as the
// authenticated buyer or by holding the signed payment cookie the grant
// route minted after verifying the payment with Solidgate.

interface AuthorizePaymentSessionAccessArgs {
  requestedSessionId: string;
  sessionUserId: string | null;
  /**
   * @deprecated Unused — the cookie's order id is verified against the orders
   * table instead. Kept in the interface so callers need no change.
   */
  sessionPaymentIntentId: string | null;
}

type PaymentSessionAccessResult =
  | {
      ok: true;
      userId: string | null;
      resolvedVia: 'account' | 'cookie';
    }
  | {
      ok: false;
      response: NextResponse;
    };

export async function authorizePaymentSessionAccess({
  requestedSessionId,
  sessionUserId,
}: AuthorizePaymentSessionAccessArgs): Promise<PaymentSessionAccessResult> {
  // Authenticated path first: a buyer whose account owns this session
  // bypasses the cookie requirement (cross-device access).
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  // "Auth session missing!" is Supabase's standard response for anonymous
  // visitors — not a real failure. Only real errors should surface as 500;
  // otherwise fall through to the cookie path.
  if (authError && authError.name !== 'AuthSessionMissingError') {
    console.error('[payment-access] auth lookup failed:', authError.message);
    return {
      ok: false,
      response: NextResponse.json({ error: 'Failed to verify user' }, { status: 500 }),
    };
  }

  if (user && sessionUserId && sessionUserId === user.id) {
    return { ok: true, userId: user.id, resolvedVia: 'account' };
  }

  // Cookie path: the payment cookie's id is the Solidgate order id
  // ({sessionId}:{tier}:{attempt}), minted by /api/solidgate/grant after the
  // server verified the payment. Verify it produced an order for THIS session.
  const cookieStore = await cookies();
  const signedCookie = cookieStore.get(PAYMENT_COOKIE_NAME)?.value;

  if (!signedCookie) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const verifiedCookie = await verifyPaymentCookie(signedCookie);
  if (!verifiedCookie || verifiedCookie.sessionId !== requestedSessionId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  if (verifiedCookie.kind !== 'pi' || !verifiedCookie.paymentIntentId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  const admin = getSupabaseAdminClient();
  const { data: cookieOrder } = await admin
    .from('orders')
    .select('id')
    .eq('payment_environment', currentPaymentEnvironment())
    .eq('solidgate_order_id', verifiedCookie.paymentIntentId)
    .eq('session_id', requestedSessionId)
    .limit(1)
    .maybeSingle();

  if (!cookieOrder) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  // Cookie path: session.user_id must match the authenticated user (if any) —
  // a logged-in user must not ride another buyer's cookie.
  if (user && (!sessionUserId || sessionUserId !== user.id)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { ok: true, userId: user?.id ?? null, resolvedVia: 'cookie' };
}
