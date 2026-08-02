import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { paymentEnvironmentForVercel } from '@repo/shared/solidgate';
import { authorizeSolidgateSession } from '@/lib/payment/solidgate-access';

export const dynamic = 'force-dynamic';

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENT_OTO_STEPS = new Set([1, 2, 3, 4, 5, 6, 7]);
const RESUME_OTO_STEPS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

export async function POST(request: Request) {
  let body: { sessionId?: unknown; currentStep?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sessionId, currentStep } = body;
  if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }
  if (
    typeof currentStep !== 'number'
    || !Number.isInteger(currentStep)
    || !CURRENT_OTO_STEPS.has(currentStep)
  ) {
    return NextResponse.json({ error: 'Invalid currentStep' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('user_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) {
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
  }
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const access = await authorizeSolidgateSession({
    sessionId,
    sessionUserId: session.user_id ?? null,
    // Progress is an authorization decision, not a charge. A valid main
    // payment cookie or the linked account remains sufficient if the saved
    // card was later removed, while unauthenticated deep links stay denied.
    requireCardToken: false,
  });
  if (!access.ok) return access.response;

  const paymentEnvironment = paymentEnvironmentForVercel(process.env.VERCEL_ENV);
  const { data, error } = await supabase.rpc('advance_solidgate_oto_progress', {
    p_payment_environment: paymentEnvironment,
    p_session_id: sessionId,
    p_current_step: currentStep,
    // Never accept this authority from the browser. Only a provider-accepted
    // purchase in charge-oto may repair a missing earlier checkpoint.
    p_allow_catch_up: false,
  });

  if (error) {
    if (
      error.message === 'oto_progress_gap'
      || error.message === 'oto_progress_environment_mismatch'
    ) {
      return NextResponse.json(
        { error: 'OTO progress is out of sequence', code: 'progress_conflict' },
        { status: 409 },
      );
    }
    if (error.message === 'oto_progress_session_not_found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    console.error('[solidgate/advance-oto] progress update failed:', error.message);
    return NextResponse.json({ error: 'Failed to persist OTO progress' }, { status: 500 });
  }

  const result = data?.[0];
  if (
    !result
    || typeof result.persisted_step !== 'number'
    || !Number.isInteger(result.persisted_step)
    || !RESUME_OTO_STEPS.has(result.persisted_step)
  ) {
    return NextResponse.json({ error: 'Failed to persist OTO progress' }, { status: 500 });
  }
  const lastOtoStep = String(result.persisted_step);
  const resumeTo = `/oto/${result.persisted_step}`;
  if (result.conflict) {
    return NextResponse.json(
      {
        error: 'OTO progress is out of sequence',
        code: 'progress_conflict',
        lastOtoStep,
        resumeTo,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    advanced: result.advanced,
    lastOtoStep,
    resumeTo,
  });
}
