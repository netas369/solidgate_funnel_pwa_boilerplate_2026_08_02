import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { PAYMENT_COOKIE_NAME, verifyPaymentCookie } from '@repo/shared/payment-cookie';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { createClient } from '@repo/shared/supabase/server';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const { data: session } = await getSupabaseAdminClient()
    .from('sessions')
    .select('id, current_step_id, quiz_answers, email, result_segment, user_id')
    .eq('id', sessionId)
    .single();

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Auth path: check Supabase auth cookie
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user && session.user_id === user.id) {
    return NextResponse.json(await maybeEnrichWithSubscription(request, session));
  }

  // Cookie path: check payment cookie
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(PAYMENT_COOKIE_NAME)?.value;

  if (cookieValue) {
    const verified = await verifyPaymentCookie(cookieValue);
    if (verified?.sessionId === sessionId) {
      return NextResponse.json(await maybeEnrichWithSubscription(request, session));
    }
  }

  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Rebill cadence, in months, for a main-plan offering code.
 *
 * Solidgate writes the CATALOG OFFERING CODE into orders.product_slug (not the
 * internal tier id), so this maps codes → months. Every checkout tier of the
 * shipped boilerplate converts into the same recurring plan, hence one entry.
 *
 * TODO(new product): add a row per offering whose billing period differs.
 */
const PLAN_MONTHS_BY_PRODUCT_CODE: Record<string, number> = {
  [SOLIDGATE_PRODUCT_CODES.main]: 1,
};

function planSlugToMonths(slug: string | null): number | null {
  if (!slug) return null;
  return PLAN_MONTHS_BY_PRODUCT_CODE[slug] ?? null;
}

async function maybeEnrichWithSubscription(
  request: Request,
  session: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const include = new URL(request.url).searchParams.get('include');
  if (include !== 'subscription') return session;

  const { data: order } = await getSupabaseAdminClient()
    .from('orders')
    .select('product_name, product_slug')
    .eq('payment_environment', currentPaymentEnvironment())
    .eq('session_id', session.id as string)
    .in('status', ['active', 'trialing'])
    .not('solidgate_subscription_id', 'is', null)
    .limit(1)
    .maybeSingle();

  return {
    ...session,
    subscription_plan_name: order?.product_name ?? null,
    plan_duration_months: planSlugToMonths(order?.product_slug ?? null),
  };
}
