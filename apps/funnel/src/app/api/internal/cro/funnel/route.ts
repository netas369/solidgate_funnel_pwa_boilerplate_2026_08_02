/**
 * The display-ready CRO drop-off funnel for one app.
 *
 * SPEC: docs/quiz-backend/CRO_DASHBOARD_CONTRACT.md — read it before changing
 * this route. If an implementation detail has to deviate from that document,
 * STOP, report the deviation and the reason, and wait for a human decision.
 *
 * The internal CRO dashboard reads MANY apps built from this template. It
 * renders; it does not interpret. Every number in the response is computed here
 * so the dashboard never has to reimplement branch handling against each
 * product's quiz. See features/cro/funnel-response.ts for the arithmetic.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdminClient } from "@repo/shared/supabase/admin";
import { QUIZ_VARIANT } from "@/features/quiz/server/quiz-definition";
import {
  assembleFunnelResponse,
  type CroStepFunnelRow,
  type SegmentOption,
} from "@/features/cro/funnel-response";
import { segmentLabel, type SegmentKind } from "@/features/cro/segment-labels";
import { authorizeInternalRequest } from "../_auth";

// An App Router GET is a caching candidate, and a cached authenticated response
// served to an unauthenticated request is a data leak.
export const dynamic = "force-dynamic";

const MAX_RANGE_DAYS = 366;

const querySchema = z
  .object({
    // Required: a dashboard that forgets the range must get a 400, not a year
    // of rows.
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    funnel: z.string().min(1).max(100).optional(),
    version: z.string().min(1).max(100).optional(),
    locale: z.string().min(1).max(35).optional(),
    source: z.string().min(1).max(50).optional(),
  })
  .strict();

interface SegmentRow {
  kind: string;
  id: string | null;
  sessions: number;
  first_seen: string | null;
  last_seen: string | null;
}

// The ids come from the database; the names come from this app's registry, so
// the dashboard never has to hold per-product knowledge. See
// features/cro/segment-labels.ts — that file is the per-product extension point.
function pickSegments(rows: SegmentRow[], kind: SegmentKind): SegmentOption[] {
  return rows
    .filter((row) => row.kind === kind && row.id !== null)
    .map((row) => {
      const id = row.id as string;
      return {
        id,
        ...segmentLabel(kind, id),
        sessions: Number(row.sessions),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
      };
    });
}

export async function GET(request: Request) {
  const denied = authorizeInternalRequest(request);
  if (denied) return denied;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  // Half-open [from, to), matching DateRange in admin/_queries/_shared.ts.
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (from >= to) {
    return NextResponse.json({ error: "invalid_range" }, { status: 400 });
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: "range_too_large" }, { status: 400 });
  }

  // Defaulting to this deployment's own constant lets the dashboard ask "what is
  // live right now?" without knowing the strings. With no activation flag in the
  // catalog, the deployed QUIZ_VARIANT IS that answer.
  const quizVariant = parsed.data.version ?? QUIZ_VARIANT;
  const admin = getSupabaseAdminClient();

  const [funnelResult, segmentResult, definitionResult] = await Promise.all([
    admin.rpc("cro_step_funnel", {
      p_from: parsed.data.from,
      p_to: parsed.data.to,
      p_quiz_variant: quizVariant,
      p_funnel_variant: parsed.data.funnel ?? null,
      p_source: parsed.data.source ?? null,
      p_locale: parsed.data.locale ?? null,
    }),
    admin.rpc("cro_funnel_segments", {
      p_from: parsed.data.from,
      p_to: parsed.data.to,
    }),
    // Sequential explicit column list rather than a nested select: CLAUDE.md
    // rule 2 — PostgREST filter strings are invisible to TypeScript.
    admin
      .from("quiz_definitions")
      .select("app_key, funnel_key, config_hash, first_step_id, total_steps")
      .eq("quiz_variant", quizVariant)
      .maybeSingle(),
  ]);

  // Deliberately NOT the admin _queries "log and return zero" convention. That
  // exists so an admin page still renders; a machine consumer handed 0 instead
  // of a 500 draws a chart with a cliff in it and nobody notices.
  for (const [name, result] of [
    ["cro_step_funnel", funnelResult],
    ["cro_funnel_segments", segmentResult],
    ["quiz_definitions", definitionResult],
  ] as const) {
    if (result.error) {
      console.error(`[internal/cro/funnel] ${name} failed:`, result.error.message);
      return NextResponse.json({ error: "query_failed" }, { status: 500 });
    }
  }

  const rows = (funnelResult.data ?? []) as unknown as CroStepFunnelRow[];
  const segmentRows = (segmentResult.data ?? []) as unknown as SegmentRow[];
  const definition = definitionResult.data;

  const body = assembleFunnelResponse(rows, {
    appKey: definition?.app_key ?? process.env.CRO_APP_KEY ?? "boilerplate",
    appLabel: process.env.CRO_APP_LABEL ?? definition?.app_key ?? "Boilerplate",
    // The template collects per-step counts only. Answers, device breakdown and
    // live dwell need data it does not record, so those tabs are not claimed
    // and the dashboard hides them rather than rendering empty.
    capabilities: ["overview", "dropoff"],
    quizVariant,
    configHash: definition?.config_hash ?? null,
    firstStepId: definition?.first_step_id ?? null,
    totalSteps: definition?.total_steps ?? null,
    terminalStepIds: rows.filter((row) => row.is_terminal).map((row) => row.step_id),
    range: { from: parsed.data.from, to: parsed.data.to },
    segments: {
      funnels: pickSegments(segmentRows, "funnel"),
      versions: pickSegments(segmentRows, "version"),
      locales: pickSegments(segmentRows, "locale"),
      selected: {
        funnel: parsed.data.funnel ?? null,
        version: quizVariant,
        locale: parsed.data.locale ?? null,
      },
    },
    generatedAt: new Date().toISOString(),
  });

  return NextResponse.json(body);
}
