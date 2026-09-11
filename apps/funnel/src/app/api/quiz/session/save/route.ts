import { NextResponse } from "next/server";
import { z } from "zod";
import { routing } from "@repo/i18n/routing";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import type { Json } from "@repo/shared/types/database";
import { authorizeQuizSession } from "@/features/quiz/server/quiz-access";
import {
  isKnownQuizStep,
  QUIZ_VARIANT,
  validateQuizAnswers,
} from "@/features/quiz/server/quiz-definition";
import {
  databaseErrorResponse,
  errorResponse,
} from "@/features/quiz/server/http";
import { validateEventMetadata } from "@/features/quiz/server/event-metadata";

const eventSchema = z
  .object({
    eventId: z.uuid(),
    type: z.enum(["step_completed", "lead_captured"]),
    stepNumber: z.number().int().nonnegative().nullable().optional(),
    metadata: z.record(z.string().max(100), z.unknown()).optional(),
  })
  .strict();

const MAX_STEP_ACTIVITY_IDS = 200;

// Step IDS ONLY. There is deliberately no timestamp field: the server stamps
// every viewed_at/answered_at with now() inside quiz_merge_step_activity, so a
// skewed or hostile client clock cannot move one.
const stepActivitySchema = z
  .object({
    activityId: z.uuid(),
    viewed: z.array(z.string().max(100)).max(MAX_STEP_ACTIVITY_IDS),
    answered: z.array(z.string().max(100)).max(MAX_STEP_ACTIVITY_IDS),
    skipped: z.array(z.string().max(100)).max(MAX_STEP_ACTIVITY_IDS),
  })
  .strict();

const saveSchema = z
  .object({
    sessionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    currentStepId: z.string().max(100).nullable().optional(),
    answers: z.record(z.string().max(100), z.unknown()),
    email: z.email().max(320).optional(),
    locale: z.string().min(1).max(35).optional(),
    consentGivenAt: z.iso.datetime({ offset: true }).optional(),
    consentVersion: z.string().min(1).max(100).optional(),
    marketingConsent: z.boolean().optional(),
    event: eventSchema.optional(),
    stepActivity: stepActivitySchema.optional(),
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

  const parsed = saveSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Quiz progress data is invalid.",
    );
  }
  const body = parsed.data;

  if (
    body.locale &&
    !(routing.locales as readonly string[]).includes(body.locale)
  ) {
    return errorResponse(400, "INVALID_LOCALE", "Locale is not supported.");
  }
  if (
    body.currentStepId !== undefined &&
    !isKnownQuizStep(body.currentStepId)
  ) {
    return errorResponse(
      400,
      "INVALID_STEP",
      "Current quiz step is not defined.",
    );
  }

  // Step activity. BOUNDS are fatal (zod already returned 400 above): an
  // oversized array or a non-uuid activityId is a bug or an attack.
  //
  // UNKNOWN STEP IDS ARE DROPPED, NOT REJECTED. They mean client/server config
  // skew — a tab still holding a bundle from before a quiz-config change.
  // Rejecting the save would 400 that tab FOREVER: its buffer never clears, so
  // it would retry the same unknown id indefinitely and stop persisting the
  // visitor's answers entirely. Dropping self-heals on the next 200, and the
  // skew stays visible in the logs. Telemetry must never cost answers.
  const activity = body.stepActivity;
  let activityViewed: string[] = [];
  let activityAnswered: string[] = [];
  let activitySkipped: string[] = [];
  if (activity) {
    // `viewed` keeps duplicates — they are the view counter. The other two are
    // deduped, which is what bounds the stored JSONB.
    activityViewed = activity.viewed.filter(isKnownQuizStep);
    activityAnswered = [...new Set(activity.answered.filter(isKnownQuizStep))];
    activitySkipped = [...new Set(activity.skipped.filter(isKnownQuizStep))];
    const submitted =
      activity.viewed.length + activity.answered.length + activity.skipped.length;
    const kept =
      activityViewed.length +
      activity.answered.filter(isKnownQuizStep).length +
      activity.skipped.filter(isKnownQuizStep).length;
    if (submitted > kept) {
      console.warn(
        `[quiz/session/save] dropped ${submitted - kept} unknown step activity id(s)`,
      );
    }
  }
  const hasStepActivity =
    activityViewed.length > 0 ||
    activityAnswered.length > 0 ||
    activitySkipped.length > 0;

  const answerValidation = validateQuizAnswers(body.answers);
  if (!answerValidation.ok) {
    const tooLarge = answerValidation.errors.answers === "PAYLOAD_TOO_LARGE";
    return errorResponse(
      tooLarge ? 413 : 422,
      tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_QUIZ_ANSWERS",
      tooLarge
        ? "The saved answers are too large."
        : "The saved answers are invalid.",
      answerValidation.errors,
    );
  }

  if (body.event) {
    const metadataValidation = validateEventMetadata(body.event.metadata ?? {});
    if (!metadataValidation.ok) {
      const tooLarge = metadataValidation.code === "PAYLOAD_TOO_LARGE";
      return errorResponse(
        tooLarge ? 413 : 422,
        metadataValidation.code,
        tooLarge
          ? "Event metadata is too large."
          : "Event metadata contains a sensitive field.",
        metadataValidation.field ? { metadata: metadataValidation.field } : undefined,
      );
    }
  }
  if (body.event?.type === "lead_captured" && !body.email) {
    return errorResponse(
      422,
      "INVALID_LEAD_CAPTURE",
      "A lead-captured event requires a valid email in the same save.",
    );
  }

  const admin = getSupabaseAdminClient();
  const { data: session, error: readError } = await admin
    .from("sessions")
    .select("id, user_id, revision, status, quiz_variant, quiz_answers")
    .eq("id", body.sessionId)
    .maybeSingle();

  if (readError) {
    console.error("[quiz/session/save] lookup failed:", readError.message);
    return errorResponse(
      500,
      "PERSISTENCE_FAILED",
      "The quiz session could not be loaded.",
    );
  }
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
      "The caller cannot update this quiz session.",
    );
  }
  if (session.quiz_variant !== QUIZ_VARIANT) {
    return errorResponse(
      409,
      "QUIZ_VARIANT_UNAVAILABLE",
      "This quiz version is not available.",
    );
  }
  if (session.status !== "active") {
    return errorResponse(
      409,
      "SESSION_ALREADY_COMPLETED",
      "Quiz session is no longer active.",
    );
  }

  const storedAnswers =
    session.quiz_answers &&
    typeof session.quiz_answers === "object" &&
    !Array.isArray(session.quiz_answers)
      ? session.quiz_answers
      : {};
  const removedKeys = Object.keys(storedAnswers).filter(
    (key) => !Object.prototype.hasOwnProperty.call(body.answers, key),
  );
  if (removedKeys.length > 0) {
    return errorResponse(
      422,
      "INVALID_QUIZ_ANSWERS",
      "Previously saved answers cannot be removed by a normal progress save.",
      { answers: "ANSWER_REMOVAL_NOT_ALLOWED" },
    );
  }

  const normalizedEmail = body.email?.trim().toLowerCase() ?? null;
  const { data, error } = await admin.rpc("save_quiz_session_progress", {
    p_session_id: body.sessionId,
    p_expected_revision: body.expectedRevision,
    p_quiz_answers: body.answers as Json,
    p_current_step_id: body.currentStepId ?? null,
    p_email: normalizedEmail,
    p_locale: body.locale ?? null,
    p_consent_given_at: body.consentGivenAt ?? null,
    p_consent_version: body.consentVersion ?? null,
    p_marketing_consent: body.marketingConsent ?? null,
    p_event_id: body.event?.eventId ?? null,
    p_event_type: body.event?.type ?? null,
    p_event_step_number: body.event?.stepNumber ?? null,
    p_event_metadata: (body.event?.metadata ?? {}) as Json,
    p_step_activity: hasStepActivity
      ? ({
          viewed: activityViewed,
          answered: activityAnswered,
          skipped: activitySkipped,
        } as Json)
      : null,
  });

  if (error) return databaseErrorResponse(error);

  const persisted = data as {
    revision?: number;
    current_step_id?: string | null;
    status?: string;
  } | null;
  return NextResponse.json({
    ok: true,
    revision: persisted?.revision ?? body.expectedRevision + 1,
    currentStepId: persisted?.current_step_id ?? body.currentStepId ?? null,
    status: persisted?.status ?? "active",
  });
}
