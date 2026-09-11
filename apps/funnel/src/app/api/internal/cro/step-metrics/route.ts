// Per-step CRO metrics for an external dashboard.
//
// Rows are keyed by stepId, NEVER stepNumber — that is the entire point. Branch
// arms share a step_number (step3 and step3b are both position 3), and
// idx_funnel_events_one_step_completion is unique on
// (session_id, event_type, step_number), so funnel_events structurally cannot
// tell the two arms apart. Join these rows to /api/internal/cro/definition on
// stepId and use `sharesPositionWith` to sum the arms.
//
// Two range decisions worth knowing:
//   * filters sessions.created_at, NOT updated_at. updated_at moves on every
//     save, so a range over it is not reproducible from one run to the next.
//     The metric is "sessions that STARTED in the window".
//   * does NOT filter source = 'quiz', unlike funnelStageSummary.started in
//     admin/_queries/funnel.ts. Advertorial-entry sessions are still quiz
//     sessions. Expect a deliberate discrepancy with the admin Funnel tab.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { authorizeInternalRequest } from "../_auth";

export const dynamic = "force-dynamic";

const MAX_RANGE_DAYS = 366;

const querySchema = z
  .object({
    // Required: a dashboard that forgets the range must get a 400, not a year
    // of rows.
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    quizVariant: z.string().min(1).max(100).optional(),
    funnelVariant: z.string().min(1).max(100).optional(),
    source: z.string().min(1).max(50).optional(),
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

  // Half-open [from, to), matching DateRange in admin/_queries/_shared.ts and
  // every .gte(from).lt(to) predicate in that directory.
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (from >= to) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: "range_too_large" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();

  // An RPC, not PostgREST: the aggregate has to jsonb_each over
  // sessions.step_activity, group by key and count answered_at IS NULL, none of
  // which .select() can express.
  const { data, error } = await admin.rpc("cro_step_funnel", {
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_quiz_variant: parsed.data.quizVariant ?? null,
    p_funnel_variant: parsed.data.funnelVariant ?? null,
    p_source: parsed.data.source ?? null,
  });

  if (error) {
    // Deliberately NOT the admin _queries "log and return a neutral zero"
    // convention. That exists so an admin page still renders; a machine
    // consumer handed 0 instead of a 500 draws a chart with a cliff in it and
    // nobody notices.
    console.error("[internal/cro/step-metrics] rpc failed:", error.message);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  return NextResponse.json({
    range: { from: parsed.data.from, to: parsed.data.to },
    filters: {
      quizVariant: parsed.data.quizVariant ?? null,
      funnelVariant: parsed.data.funnelVariant ?? null,
      source: parsed.data.source ?? null,
    },
    steps: (data ?? []).map((row) => ({
      quizVariant: row.quiz_variant,
      funnelVariant: row.funnel_variant,
      stepId: row.step_id,
      position: row.step_position,
      sortIndex: row.sort_index,
      type: row.step_type,
      phaseKey: row.phase_key,
      label: row.label,
      isQuestion: row.is_question,
      isTerminal: row.is_terminal,
      // The branch-vs-drop signal. Split a position's screens on this: true
      // screens are on the spine and their drop is real; false screens were
      // shown to only some visitors.
      isUnconditional: row.is_unconditional,
      entrySkippable: row.entry_skippable,
      // False when the step is published but saw nobody in this window. Sent so
      // the funnel list does not silently end at the deepest step reached —
      // which also hides a routing bug that shows a step to zero people.
      hasTraffic: row.has_traffic,
      // False means this step id has no published definition — the catalog is
      // stale for this quiz_variant. Publish before trusting the labels.
      inCatalog: row.in_catalog,
      positionCohort: row.position_cohort,
      viewed: row.viewed,
      answered: row.answered,
      skipped: row.skipped,
      advanced: row.advanced,
      dropped: row.dropped,
      // Sessions still in progress: viewed this step, have not advanced, and
      // are too recent to call abandoned. Excluded from `dropped` on purpose.
      unsettled: row.unsettled,
      totalViews: row.total_views,
      revisits: row.revisits,
      p50SecondsToAnswer: row.p50_seconds_to_answer,
      p90SecondsToAnswer: row.p90_seconds_to_answer,
    })),
  });
}
