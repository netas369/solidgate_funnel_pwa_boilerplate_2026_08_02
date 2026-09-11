// Published quiz definition, for an external CRO dashboard.
//
// The dashboard joins this to /api/internal/cro/step-metrics on `stepId` to
// label steps and to tell a BRANCH from a DROP: steps sharing a `position` are
// alternative arms, so a visitor traverses one and the other legitimately has
// no data. Without this, a reader sees only integers.
//
// Returns no user data — this is the quiz's own structure.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import {
  FUNNEL_VARIANT,
  QUIZ_VARIANT,
} from "@/features/quiz/server/quiz-definition";
import { authorizeInternalRequest } from "../_auth";

// An App Router GET is a caching candidate, and a cached authenticated response
// served to an unauthenticated request is a data leak. Reading request.headers
// already opts out; this is explicit.
export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    quizVariant: z.string().min(1).max(100).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const denied = authorizeInternalRequest(request);
  if (denied) return denied;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  // Defaulting to the app's own constants lets the dashboard ask "what is live
  // right now?" without knowing the strings. With no activation flag in the
  // catalog, the deployed QUIZ_VARIANT *is* that answer.
  const quizVariant = parsed.data.quizVariant ?? QUIZ_VARIANT;
  const admin = getSupabaseAdminClient();

  // Sequential explicit queries rather than one nested PostgREST select:
  // CLAUDE.md rule 2 — filter strings are invisible to TypeScript, and a
  // multi-table nested select string is exactly what that warns about.
  const { data: definition, error: definitionError } = await admin
    .from("quiz_definitions")
    .select(
      "quiz_variant, app_key, funnel_key, first_step_id, total_steps, config_hash, published_at",
    )
    .eq("quiz_variant", quizVariant)
    .maybeSingle();

  if (definitionError) {
    console.error("[internal/cro/definition] definition read failed:", definitionError.message);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }
  if (!definition) {
    return NextResponse.json({ error: "not_published" }, { status: 404 });
  }

  const { data: steps, error: stepsError } = await admin
    .from("quiz_definition_steps")
    .select(
      "step_id, position, sort_index, step_type, phase_key, store_as, is_question, is_terminal, answer_keys, label_key, label, is_unconditional, entry_skippable",
    )
    .eq("quiz_variant", quizVariant)
    .order("sort_index", { ascending: true });

  if (stepsError) {
    console.error("[internal/cro/definition] steps read failed:", stepsError.message);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const { data: edges, error: edgesError } = await admin
    .from("quiz_definition_step_edges")
    .select("from_step_id, to_step_id, on_value, edge_index")
    .eq("quiz_variant", quizVariant)
    .order("edge_index", { ascending: true });

  if (edgesError) {
    console.error("[internal/cro/definition] edges read failed:", edgesError.message);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const rows = steps ?? [];
  const byPosition = new Map<number, string[]>();
  for (const step of rows) {
    const key = step.position as number;
    byPosition.set(key, [...(byPosition.get(key) ?? []), step.step_id as string]);
  }

  return NextResponse.json({
    app: { appKey: definition.app_key, funnelKey: definition.funnel_key },
    quiz: {
      quizVariant: definition.quiz_variant,
      configHash: definition.config_hash,
      firstStepId: definition.first_step_id,
      totalSteps: definition.total_steps,
      publishedAt: definition.published_at,
    },
    // What this deployment is writing onto new sessions right now.
    live: { quizVariant: QUIZ_VARIANT, funnelVariant: FUNNEL_VARIANT },
    steps: rows.map((step) => ({
      stepId: step.step_id,
      position: step.position,
      sortIndex: step.sort_index,
      type: step.step_type,
      phaseKey: step.phase_key,
      storeAs: step.store_as,
      // Resolved sentence, not the i18n key: every string in quiz-config.ts is
      // a key, so a dashboard fed the config alone would title its rows
      // "steps.step1.question". The key is kept for later localisation.
      label: step.label,
      labelKey: step.label_key,
      isQuestion: step.is_question,
      isTerminal: step.is_terminal,
      // True when EVERY route passes through this step. False means only some
      // visitors were routed here, so its drop belongs to its own views rather
      // than the position's traffic — the difference between a branch and a
      // drop-off.
      isUnconditional: step.is_unconditional,
      entrySkippable: step.entry_skippable,
      answerKeys: step.answer_keys ?? [],
      nextSteps: (edges ?? [])
        .filter((edge) => edge.from_step_id === step.step_id)
        .map((edge) => ({ to: edge.to_step_id, on: edge.on_value })),
      // The branch signal. Sum these arms' `viewed` before reading a dip at
      // this position as a drop.
      sharesPositionWith: (byPosition.get(step.position as number) ?? []).filter(
        (id) => id !== step.step_id,
      ),
    })),
  });
}
