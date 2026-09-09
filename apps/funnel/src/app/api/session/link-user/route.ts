import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { createClient } from '@repo/shared/supabase/server';
import { authorizeQuizSession } from '@/features/quiz/server/quiz-access';
import { databaseErrorResponse, errorResponse } from '@/features/quiz/server/http';

const linkSchema = z.object({ sessionId: z.uuid() }).strict();

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
  }
  const parsed = linkSchema.safeParse(rawBody);
  if (!parsed.success) return errorResponse(400, 'INVALID_REQUEST', 'Session id is invalid.');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse(401, 'AUTHENTICATION_REQUIRED', 'Sign in before linking a quiz.');

  const admin = getSupabaseAdminClient();
  const { data: session, error: readError } = await admin
    .from('sessions')
    .select('id, user_id')
    .eq('id', parsed.data.sessionId)
    .maybeSingle();
  if (readError) return databaseErrorResponse(readError);
  if (!session) return errorResponse(404, 'SESSION_NOT_FOUND', 'Quiz session was not found.');

  const access = await authorizeQuizSession(session.id, session.user_id);
  if (!access.ok) {
    return errorResponse(access.status, access.code, 'The caller cannot link this quiz session.');
  }

  const { data, error } = await admin.rpc('link_quiz_session_user', {
    p_session_id: session.id,
    p_user_id: user.id,
  });
  if (error?.message === 'QUIZ_SESSION_OWNERSHIP_MISMATCH') {
    return errorResponse(409, 'SESSION_OWNERSHIP_MISMATCH', 'The session belongs to another user.');
  }
  if (error) return databaseErrorResponse(error);
  return NextResponse.json({ ok: true, session: data });
}
