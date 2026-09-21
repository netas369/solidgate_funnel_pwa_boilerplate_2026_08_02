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
  QUIZ_VARIANT,
} from '@/features/quiz/server/quiz-definition';
import { buildQuizClientContext } from '@/features/quiz/server/client-context';
import { assignFunnelVariant } from '@/features/quiz/server/experiment-assignment';
import { errorResponse } from '@/features/quiz/server/http';
import { isKnownMetaCrawler } from '@/features/quiz/server/meta-crawler';

const allowedSources = [
  'quiz',
  'main',
  'advertorial',
  'special-offer',
  'special-offer-free',
] as const;

const VISITOR_COOKIE_NAME = 'funnel_visitor_id';
const VISITOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const attributionValue = z.string().min(1).max(500);
const attributionTouchSchema = z
  .object({
    utm_source: attributionValue.optional(),
    utm_medium: attributionValue.optional(),
    utm_campaign: attributionValue.optional(),
    utm_content: attributionValue.optional(),
    utm_term: attributionValue.optional(),
    fbclid: attributionValue.optional(),
    gclid: attributionValue.optional(),
    gbraid: attributionValue.optional(),
    wbraid: attributionValue.optional(),
    ttclid: attributionValue.optional(),
    msclkid: attributionValue.optional(),
    landing_url: attributionValue.optional(),
    referrer: attributionValue.optional(),
    captured_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const attributionSchema = z
  .object({
    first_touch: attributionTouchSchema,
    last_touch: attributionTouchSchema,
    fbc: attributionValue
      .regex(/^fb\.[0-9]+\.[0-9]{10,16}\.[A-Za-z0-9._-]{1,400}$/)
      .optional(),
    fbp: attributionValue
      .regex(/^fb\.[0-9]+\.[0-9]{10,16}\.[A-Za-z0-9._-]{1,400}$/)
      .optional(),
  })
  .strict();

const createSchema = z
  .object({
    sessionId: z.uuid().optional(),
    locale: z.string().min(1).max(35),
    source: z.enum(allowedSources).default('quiz'),
    attribution: attributionSchema.optional(),
  })
  .strict();

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const item of cookie.split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(parts.join('='));
    } catch {
      return parts.join('=');
    }
  }
  return null;
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
  const existingVisitor = z.uuid().safeParse(cookieValue(request, VISITOR_COOKIE_NAME));
  const visitorId = existingVisitor.success
    ? existingVisitor.data
    : crypto.randomUUID();
  const funnelVariant = assignFunnelVariant(visitorId);
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
    p_visitor_id: visitorId,
    p_quiz_variant: QUIZ_VARIANT,
    p_funnel_variant: funnelVariant,
    p_locale: body.locale,
    p_source: body.source,
    p_attribution: (body.attribution ?? {}) as Json,
    p_client_context: buildQuizClientContext(request),
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
        quizVariant: QUIZ_VARIANT,
        funnelVariant,
        source: body.source,
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
  response.cookies.set(VISITOR_COOKIE_NAME, visitorId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: VISITOR_COOKIE_MAX_AGE,
  });
  return response;
}
