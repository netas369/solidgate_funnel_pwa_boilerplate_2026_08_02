import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import type { Json } from "@repo/shared/types/database";
import { authorizeQuizSession } from "@/features/quiz/server/quiz-access";
import {
  databaseErrorResponse,
  errorResponse,
} from "@/features/quiz/server/http";

const clientEventTypes = [
  "results_viewed",
  "offer_viewed",
  "offer_accepted",
  "offer_declined",
  "oto_viewed",
  "oto_accepted",
  "oto_declined",
] as const;

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const eventSchema = z
  .object({
    eventId: z.uuid(),
    sessionId: z.uuid(),
    type: z.enum(clientEventTypes),
    stepNumber: z.number().int().nonnegative().nullable().optional(),
    metadata: z.record(z.string().max(100), z.unknown()).optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
    );
  }
  const parsed = eventSchema.safeParse(rawBody);
  if (!parsed.success)
    return errorResponse(400, "INVALID_REQUEST", "Funnel event is invalid.");
  if (JSON.stringify(parsed.data.metadata ?? {}).length > 8 * 1024) {
    return errorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      "Event metadata is too large.",
    );
  }
  if (parsed.data.occurredAt) {
    const occurredAt = Date.parse(parsed.data.occurredAt);
    const now = Date.now();
    if (
      occurredAt < now - MAX_EVENT_AGE_MS ||
      occurredAt > now + MAX_EVENT_FUTURE_SKEW_MS
    ) {
      return errorResponse(
        422,
        "INVALID_OCCURRED_AT",
        "Event time must be within the accepted delivery window.",
      );
    }
  }

  const admin = getSupabaseAdminClient();
  const { data: session, error: readError } = await admin
    .from("sessions")
    .select("id, user_id")
    .eq("id", parsed.data.sessionId)
    .maybeSingle();
  if (readError) return databaseErrorResponse(readError);
  if (!session)
    return errorResponse(
      404,
      "SESSION_NOT_FOUND",
      "Quiz session was not found.",
    );

  const access = await authorizeQuizSession(session.id, session.user_id);
  if (!access.ok) {
    return errorResponse(
      access.status,
      access.code,
      "The caller cannot record this event.",
    );
  }

  const { data, error } = await admin.rpc("record_funnel_event", {
    p_event_id: parsed.data.eventId,
    p_session_id: session.id,
    p_event_type: parsed.data.type,
    p_step_number: parsed.data.stepNumber ?? null,
    p_metadata: (parsed.data.metadata ?? {}) as Json,
    p_occurred_at: parsed.data.occurredAt ?? null,
  });
  if (error) return databaseErrorResponse(error);
  return NextResponse.json({
    ok: true,
    eventId: parsed.data.eventId,
    id: data,
  });
}
