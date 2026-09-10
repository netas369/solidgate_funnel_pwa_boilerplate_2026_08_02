import { NextResponse } from 'next/server';
import { z } from 'zod';
import { routing } from '@repo/i18n/routing';
import {
  QUIZ_SESSION_COOKIE_MAX_AGE,
  QUIZ_SESSION_COOKIE_NAME,
  signQuizSessionCookie,
} from '@repo/shared/quiz-session-cookie';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { Json } from '@repo/shared/types/database';
import {
  FUNNEL_VARIANT,
  QUIZ_VARIANT,
} from '@/features/quiz/server/quiz-definition';
import { errorResponse } from '@/features/quiz/server/http';
import { isKnownMetaCrawler } from '@/features/quiz/server/meta-crawler';

const allowedSources = [
  'quiz',
  'main',
  'advertorial',
  'special-offer',
  'special-offer-free',
] as const;

const attributionSchema = z
  .record(z.string().max(100), z.string().max(255).nullable())
  .refine((value) => Object.keys(value).length <= 20, 'Too many attribution fields');

const createSchema = z
  .object({
    sessionId: z.uuid().optional(),
    visitorId: z.string().min(1).max(255).optional(),
    locale: z.string().min(1).max(35),
    source: z.enum(allowedSources).default('quiz'),
    attribution: attributionSchema.optional(),
  })
  .strict();

function clientContext(request: Request): Json {
  const userAgent = request.headers.get('user-agent') ?? '';
  const deviceType = /ipad|tablet/i.test(userAgent)
    ? 'tablet'
    : /mobile|iphone|android/i.test(userAgent)
      ? 'mobile'
      : userAgent
        ? 'desktop'
        : 'unknown';
  const browser = /edg\//i.test(userAgent)
    ? 'Edge'
    : /chrome\//i.test(userAgent)
      ? 'Chrome'
      : /safari\//i.test(userAgent)
        ? 'Safari'
        : /firefox\//i.test(userAgent)
          ? 'Firefox'
          : 'unknown';

  return {
    device_type: deviceType,
    browser,
    country: request.headers.get('x-vercel-ip-country'),
  };
}

export async function POST(request: Request) {
  // Keep session creation tied to page activation so zero-interaction exits
  // remain measurable. Exclude only explicit Meta crawler UAs before signing a
  // cookie or writing quiz_started/session data. Do not use fbclid, referrer,
  // FBAN, FBAV, or Instagram as bot signals: real ad visitors contain them.
  if (isKnownMetaCrawler(request.headers.get('user-agent'))) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'User-Agent',
      },
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
  }

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(400, 'INVALID_REQUEST', 'Session creation data is invalid.');
  }

  const body = parsed.data;
  if (!(routing.locales as readonly string[]).includes(body.locale)) {
    return errorResponse(400, 'INVALID_LOCALE', 'Locale is not supported.');
  }

  const sessionId = body.sessionId ?? crypto.randomUUID();
  let signedCookie: string;
  try {
    // Resolve configuration before inserting the row. A missing secret must
    // not leave an anonymous session that the browser can never access.
    signedCookie = await signQuizSessionCookie(sessionId);
  } catch (error) {
    console.error(
      '[quiz/session/create] cookie configuration failed:',
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      500,
      'QUIZ_SESSION_CONFIGURATION_ERROR',
      'Quiz session security is not configured.',
    );
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc('create_quiz_session', {
    p_session_id: sessionId,
    p_email: null,
    p_visitor_id: body.visitorId ?? null,
    p_quiz_variant: QUIZ_VARIANT,
    p_funnel_variant: FUNNEL_VARIANT,
    p_locale: body.locale,
    p_source: body.source,
    p_attribution: (body.attribution ?? {}) as Json,
    p_client_context: clientContext(request),
    p_event_id: crypto.randomUUID(),
  });

  if (error) {
    if (error.code === '23505') {
      return errorResponse(409, 'SESSION_ALREADY_EXISTS', 'This session already exists.');
    }
    console.error('[quiz/session/create] failed:', error.message);
    return errorResponse(500, 'PERSISTENCE_FAILED', 'The quiz session could not be created.');
  }

  const response = NextResponse.json(
    {
      session: {
        id: sessionId,
        status: 'active',
        currentStepId: null,
        answers: {},
        revision: 0,
      },
      persisted: data,
    },
    { status: 201 },
  );
  response.cookies.set(QUIZ_SESSION_COOKIE_NAME, signedCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: QUIZ_SESSION_COOKIE_MAX_AGE,
  });
  return response;
}
