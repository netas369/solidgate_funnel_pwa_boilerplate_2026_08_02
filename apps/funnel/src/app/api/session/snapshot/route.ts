import { NextResponse } from "next/server";
import { z } from "zod";
import { routing } from "@repo/i18n/routing";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import type { Json } from "@repo/shared/types/database";
import { addContactToEmailList } from "@/lib/activecampaign/client";
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

const eventSchema = z
  .object({
    eventId: z.uuid(),
    type: z.enum(["step_completed", "lead_captured"]),
    stepNumber: z.number().int().nonnegative().nullable().optional(),
    metadata: z.record(z.string().max(100), z.unknown()).optional(),
  })
  .strict();

const persistSchema = z
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

  const parsed = persistSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Quiz snapshot request is invalid.",
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

  const answerValidation = validateQuizAnswers(body.answers);
  if (!answerValidation.ok) {
    const tooLarge = answerValidation.errors.answers === "PAYLOAD_TOO_LARGE";
    return errorResponse(
      tooLarge ? 413 : 422,
      tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_QUIZ_ANSWERS",
      tooLarge
        ? "The answer snapshot is too large."
        : "The answer snapshot is invalid.",
      answerValidation.errors,
    );
  }

  if (
    body.event &&
    JSON.stringify(body.event.metadata ?? {}).length > 8 * 1024
  ) {
    return errorResponse(
      413,
      "PAYLOAD_TOO_LARGE",
      "Event metadata is too large.",
    );
  }
  if (body.event?.type === "lead_captured" && !body.email) {
    return errorResponse(
      422,
      "INVALID_LEAD_CAPTURE",
      "A lead-captured event requires a valid email in the same snapshot.",
    );
  }

  const admin = getSupabaseAdminClient();
  const { data: session, error: readError } = await admin
    .from("sessions")
    .select("id, user_id, revision, status, quiz_variant, locale")
    .eq("id", body.sessionId)
    .maybeSingle();

  if (readError) {
    console.error("[session/persist] lookup failed:", readError.message);
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

  const normalizedEmail = body.email?.trim().toLowerCase() ?? null;
  const { data, error } = await admin.rpc("persist_quiz_session_snapshot", {
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
  });

  if (error) return databaseErrorResponse(error);

  if (normalizedEmail) {
    const effectiveLocale = body.locale ?? session.locale;
    void addContactToEmailList(normalizedEmail, effectiveLocale).catch(
      (contactError) => {
        console.error(
          "[session/persist] ActiveCampaign add failed:",
          contactError instanceof Error ? contactError.message : contactError,
        );
      },
    );
  }

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
