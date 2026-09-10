import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { authorizeQuizSession } from '@/features/quiz/server/quiz-access';
import { databaseErrorResponse, errorResponse } from '@/features/quiz/server/http';

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');

  const parsedSessionId = z.uuid().safeParse(sessionId);
  if (!parsedSessionId.success) {
    return errorResponse(400, 'INVALID_REQUEST', 'A valid sessionId is required.');
  }

  const { data: session, error } = await getSupabaseAdminClient()
    .from('sessions')
    .select(
      'id, current_step_id, quiz_answers, quiz_result, result_segment, user_id, status, revision, quiz_variant, funnel_variant, locale, source, completed_at',
    )
    .eq('id', parsedSessionId.data)
    .maybeSingle();

  if (error) return databaseErrorResponse(error);
  if (!session) {
    return errorResponse(404, 'SESSION_NOT_FOUND', 'Quiz session was not found.');
  }

  const access = await authorizeQuizSession(session.id, session.user_id);
  if (!access.ok) {
    return errorResponse(access.status, access.code, 'The caller cannot read this quiz session.');
  }
  return NextResponse.json(session);
}
