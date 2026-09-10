import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { Json } from '@repo/shared/types/database';
import { authorizeQuizSession } from '@/features/quiz/server/quiz-access';
import {
  QUIZ_VARIANT,
  type QuizAnswers,
  validateQuizAnswers,
} from '@/features/quiz/server/quiz-definition';
import { scoreQuiz } from '@/features/quiz/server/quiz-scoring';
import { databaseErrorResponse, errorResponse } from '@/features/quiz/server/http';

const completeSchema = z
  .object({
    sessionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
  }
  const parsed = completeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(400, 'INVALID_REQUEST', 'Completion request is invalid.');
  }

  const admin = getSupabaseAdminClient();
  const { data: session, error: readError } = await admin
    .from('sessions')
    .select(
      'id, user_id, revision, status, quiz_variant, quiz_answers, quiz_result, result_segment, completed_at',
    )
    .eq('id', parsed.data.sessionId)
    .maybeSingle();

  if (readError) {
    console.error('[quiz/session/complete] lookup failed:', readError.message);
    return errorResponse(500, 'PERSISTENCE_FAILED', 'The quiz session could not be loaded.');
  }
  if (!session) return errorResponse(404, 'SESSION_NOT_FOUND', 'Quiz session was not found.');

  const access = await authorizeQuizSession(session.id, session.user_id);
  if (!access.ok) {
    return errorResponse(access.status, access.code, 'The caller cannot complete this quiz session.');
  }

  if (session.status === 'completed' && session.quiz_result) {
    return NextResponse.json({
      sessionId: session.id,
      status: session.status,
      revision: session.revision,
      resultSegment: session.result_segment,
      result: session.quiz_result,
      completedAt: session.completed_at,
    });
  }
  if (session.quiz_variant !== QUIZ_VARIANT) {
    return errorResponse(409, 'QUIZ_VARIANT_UNAVAILABLE', 'This quiz version is not available.');
  }
  if (session.status !== 'active') {
    return errorResponse(409, 'SESSION_ALREADY_COMPLETED', 'Quiz session is no longer active.');
  }

  const validation = validateQuizAnswers(session.quiz_answers, { requireComplete: true });
  if (!validation.ok) {
    return errorResponse(
      422,
      'INVALID_QUIZ_ANSWERS',
      'Required quiz answers are missing or invalid.',
      validation.errors,
    );
  }

  const score = scoreQuiz(session.quiz_answers as QuizAnswers);
  const { data, error } = await admin.rpc('complete_quiz_session', {
    p_session_id: session.id,
    p_expected_revision: parsed.data.expectedRevision,
    p_quiz_result: score.result,
    p_result_segment: score.segment,
    p_event_id: crypto.randomUUID(),
  });
  if (error) return databaseErrorResponse(error);

  const completed = data as {
    status?: string;
    revision?: number;
    quiz_result?: Json;
    result_segment?: string;
    completed_at?: string;
  } | null;
  return NextResponse.json({
    sessionId: session.id,
    status: completed?.status ?? 'completed',
    revision: completed?.revision ?? parsed.data.expectedRevision + 1,
    resultSegment: completed?.result_segment ?? score.segment,
    result: completed?.quiz_result ?? score.result,
    completedAt: completed?.completed_at ?? null,
  });
}
