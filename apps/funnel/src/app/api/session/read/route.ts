import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { authorizeQuizSession } from '@/features/quiz/server/quiz-access';
import { errorResponse } from '@/features/quiz/server/http';

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  const { data: session } = await getSupabaseAdminClient()
    .from('sessions')
    .select(
      'id, current_step_id, quiz_answers, quiz_result, email, result_segment, user_id, status, revision, quiz_variant, funnel_variant, locale, completed_at',
    )
    .eq('id', sessionId)
    .single();

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const access = await authorizeQuizSession(session.id, session.user_id);
  if (!access.ok) {
    return errorResponse(access.status, access.code, 'The caller cannot read this quiz session.');
  }
  return NextResponse.json(await maybeEnrichWithSubscription(request, session));
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
