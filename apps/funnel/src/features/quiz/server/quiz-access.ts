import { cookies } from 'next/headers';
import {
  QUIZ_SESSION_COOKIE_NAME,
  verifyQuizSessionCookie,
} from '@repo/shared/quiz-session-cookie';
import { createClient } from '@repo/shared/supabase/server';

export type QuizAccessResult =
  | { ok: true; userId: string | null; via: 'account' | 'quiz_cookie' }
  | { ok: false; status: 401 | 403 | 500; code: string };

export async function authorizeQuizSession(
  sessionId: string,
  sessionUserId: string | null,
): Promise<QuizAccessResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError && authError.name !== 'AuthSessionMissingError') {
    console.error('[quiz-access] auth lookup failed:', authError.message);
    return { ok: false, status: 500, code: 'AUTH_LOOKUP_FAILED' };
  }

  if (user && sessionUserId === user.id) {
    return { ok: true, userId: user.id, via: 'account' };
  }

  const cookieStore = await cookies();
  const quizCookie = cookieStore.get(QUIZ_SESSION_COOKIE_NAME)?.value;
  if (quizCookie) {
    let cookieSessionId: string | null;
    try {
      cookieSessionId = await verifyQuizSessionCookie(quizCookie);
    } catch (error) {
      console.error(
        '[quiz-access] cookie verification configuration failed:',
        error instanceof Error ? error.message : error,
      );
      return { ok: false, status: 500, code: 'QUIZ_SESSION_CONFIGURATION_ERROR' };
    }
    if (cookieSessionId === sessionId) {
      if (user && sessionUserId && sessionUserId !== user.id) {
        return { ok: false, status: 403, code: 'SESSION_OWNERSHIP_MISMATCH' };
      }
      return { ok: true, userId: user?.id ?? null, via: 'quiz_cookie' };
    }
  }

  return {
    ok: false,
    status: user && sessionUserId && sessionUserId !== user.id ? 403 : 401,
    code: user && sessionUserId && sessionUserId !== user.id
      ? 'SESSION_OWNERSHIP_MISMATCH'
      : 'UNAUTHORIZED_SESSION',
  };
}
