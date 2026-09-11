import { NextResponse } from "next/server";
import { createClient } from "@repo/shared/supabase/server";
import {
  ANALYTICS_EVENT_KEY_PATTERN,
  ANALYTICS_EVENT_NAME_PATTERN,
  recordAnalyticsEvent,
  sanitizeAnalyticsProperties,
} from "@repo/shared/analytics/server";
import { resolveSessionUserId } from "@/lib/session";

export async function POST(request: Request) {
  const userId = await resolveSessionUserId(await createClient());
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { eventName?: unknown; eventKey?: unknown; properties?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    typeof body.eventName !== "string" ||
    !ANALYTICS_EVENT_NAME_PATTERN.test(body.eventName) ||
    typeof body.eventKey !== "string" ||
    !ANALYTICS_EVENT_KEY_PATTERN.test(body.eventKey.trim())
  ) {
    return NextResponse.json({ error: "invalid_event" }, { status: 400 });
  }

  let properties;
  try {
    properties = sanitizeAnalyticsProperties(body.properties);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "invalid_properties" },
      { status: 400 },
    );
  }

  try {
    await recordAnalyticsEvent({
      sourceApp: "pwa",
      sourceChannel: "client",
      eventKey: body.eventKey,
      eventName: body.eventName,
      distinctId: userId,
      userId,
      properties,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[analytics/pwa] insert failed", error);
    return NextResponse.json({ error: "analytics_insert_failed" }, { status: 500 });
  }
}
