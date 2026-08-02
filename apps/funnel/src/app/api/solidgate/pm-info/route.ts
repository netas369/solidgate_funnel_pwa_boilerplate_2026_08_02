import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { authorizeSolidgateSession } from '@/lib/payment/solidgate-access';

/**
 * The saved card's brand + last4, for the one-click "pay with •••• 4242" UI.
 *
 * No PSP round-trip on the render path: both were captured from the checkout
 * order and stored in the session vault, so an OTO page costs one local read
 * instead of a provider API call.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();
    const { data: session } = await supabase
      .from('sessions')
      .select('user_id')
      .eq('id', sessionId)
      .maybeSingle();

    const access = await authorizeSolidgateSession({
      sessionId,
      sessionUserId: session?.user_id ?? null,
    });
    if (!access.ok) return access.response;

    return NextResponse.json({
      brand: access.vault.cardBrand ?? 'card',
      last4: access.vault.cardLast4 ?? '••••',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
