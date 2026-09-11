import { NextResponse } from 'next/server';
import { createClient } from '@repo/shared/supabase/server';
import {
  ANALYTICS_EVENT_KEY_PATTERN,
  ANALYTICS_EVENT_NAME_PATTERN,
  recordAnalyticsEvent,
  sanitizeAnalyticsProperties,
} from '@repo/shared/analytics/server';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let body: {
    eventName?: unknown;
    eventKey?: unknown;
    sessionId?: unknown;
    properties?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (
    typeof body.eventName !== 'string'
    || !ANALYTICS_EVENT_NAME_PATTERN.test(body.eventName)
    || typeof body.eventKey !== 'string'
    || !ANALYTICS_EVENT_KEY_PATTERN.test(body.eventKey.trim())
  ) {
    return NextResponse.json({ error: 'invalid_event' }, { status: 400 });
  }

  const sessionId = body.sessionId === null || body.sessionId === undefined
    ? null
    : typeof body.sessionId === 'string' && UUID_PATTERN.test(body.sessionId)
      ? body.sessionId
      : undefined;
  if (sessionId === undefined) {
    return NextResponse.json({ error: 'invalid_session_id' }, { status: 400 });
  }

  let properties;
  try {
    properties = sanitizeAnalyticsProperties(body.properties);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'invalid_properties' },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  try {
    await recordAnalyticsEvent({
      sourceApp: 'funnel',
      sourceChannel: 'client',
      eventKey: body.eventKey,
      eventName: body.eventName,
      distinctId: user?.id ?? sessionId ?? body.eventKey,
      userId: user?.id ?? null,
      sessionId,
      properties,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error('[analytics/funnel] insert failed', error);
    return NextResponse.json({ error: 'analytics_insert_failed' }, { status: 500 });
  }
}
