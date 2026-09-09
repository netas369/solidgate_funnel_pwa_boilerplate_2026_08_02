import { NextResponse } from 'next/server';
import { z } from 'zod';
import { routing } from '@repo/i18n/routing';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
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

const allowedSources = ['quiz', 'special-offer', 'special-offer-free'] as const;

const attributionSchema = z
  .record(z.string().max(100), z.string().max(255).nullable())
  .refine((value) => Object.keys(value).length <= 20, 'Too many attribution fields');

const createSchema = z
  .object({
    sessionId: z.uuid().optional(),
    visitorId: z.string().min(1).max(255).optional(),
    locale: z.string().min(1).max(35),
    source: z.enum(allowedSources).default('quiz'),
    email: z.email().max(320).optional(),
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

async function alreadyHasActiveEntitlement(email: string): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  const { data: userId, error: lookupError } = await admin.rpc(
    'find_auth_user_id_by_email',
    { p_email: email },
  );
  if (lookupError) {
    console.error('[session/create] account lookup failed:', lookupError.message);
    return false;
  }
  if (typeof userId !== 'string' || !userId) return false;

  const { data: active, error: entitlementError } = await admin
    .from('entitlements')
    .select('product_slug')
    .eq('payment_environment', currentPaymentEnvironment())
    .eq('user_id', userId)
    .eq('status', 'active')
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .limit(1);
  if (entitlementError) {
    console.error('[session/create] entitlement lookup failed:', entitlementError.message);
    return false;
  }
  return Boolean(active?.length);
}

export async function POST(request: Request) {
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

  if (
    body.email &&
    (body.source === 'special-offer' || body.source === 'special-offer-free') &&
    (await alreadyHasActiveEntitlement(body.email))
  ) {
    return NextResponse.json(
      {
        error: 'already_subscribed',
        message: 'An account with this email already has an active plan.',
      },
      { status: 409 },
    );
  }

  const sessionId = body.sessionId ?? crypto.randomUUID();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc('create_quiz_session', {
    p_session_id: sessionId,
    p_email: body.email?.trim().toLowerCase() ?? null,
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
    console.error('[session/create] failed:', error.message);
    return errorResponse(500, 'PERSISTENCE_FAILED', 'The quiz session could not be created.');
  }

  const signedCookie = await signQuizSessionCookie(sessionId);
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
