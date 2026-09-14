// server-only — never import from a 'use client' module.
//
// Every read in this app goes through a cro_* RPC. There is no `.from('table')`
// call anywhere in apps/cro, and that is not a style preference: this app is
// never given SUPABASE_SERVICE_ROLE_KEY, so it authenticates with the anon key
// plus the analyst's own JWT. The catalog tables are revoked from
// `authenticated` outright, and `sessions` is RLS-scoped to auth.uid(), which is
// never the analyst. The SECURITY DEFINER functions below return aggregates,
// and that is the entire reason an analyst can see a funnel report but not a
// single visitor's answers.
//
// src/lib/no-service-role.test.ts fails the build if that ever stops being true.
//
// A 42501 from any of these means the caller is not in cro_analysts. That is a
// real state worth distinguishing from "no data", so it is surfaced rather than
// swallowed.

import { createClient } from '@repo/shared/supabase/server';
import type { CroStepFunnelRow } from '@repo/shared/cro/funnel-response';
import type { DashboardFilters } from './filters';

/** ISO-8601 UTC bounds. `from` inclusive, `to` exclusive. */
export interface DateRange {
  from: string;
  to: string;
}

/** One option on a filter chip row, from cro_funnel_segments. */
export interface SegmentOptionRow {
  kind: 'funnel' | 'version' | 'locale' | 'device' | 'country' | 'source';
  id: string;
  sessions: number;
  first_seen: string;
  last_seen: string;
}

export interface CatalogRow {
  quiz_variant: string;
  app_key: string;
  funnel_key: string;
  first_step_id: string;
  total_steps: number;
  config_hash: string;
  published_at: string;
  step_id: string;
  step_position: number;
  sort_index: number;
  step_type: string;
  phase_key: string | null;
  store_as: string | null;
  label: string | null;
  is_question: boolean;
  is_terminal: boolean;
  is_unconditional: boolean;
  entry_skippable: boolean;
  answer_keys: string[];
  option_values: string[];
  /** Option code → resolved copy. Empty for steps with no options. */
  option_labels: Record<string, string>;
}

export interface SessionTotalsRow {
  quiz_variant: string;
  funnel_variant: string;
  sessions: number;
  with_activity: number;
  no_activity: number;
  completed: number;
  abandoned_settled: number;
  unsettled: number;
  lead_captured: number;
  p50_seconds_to_complete: number | null;
  p90_seconds_to_complete: number | null;
}

export interface LiveRow {
  quiz_variant: string;
  funnel_variant: string;
  step_id: string;
  step_position: number | null;
  sort_index: number | null;
  label: string | null;
  is_question: boolean;
  in_catalog: boolean;
  /** Which of the three fallbacks resolved the step. See cro_live_sessions. */
  step_basis: 'current_step_id' | 'last_viewed' | 'landing';
  active_sessions: number;
  p50_dwell_seconds: number | null;
  p90_dwell_seconds: number | null;
  max_dwell_seconds: number | null;
}

export interface AnswerRow {
  step_id: string;
  step_position: number;
  sort_index: number;
  label: string | null;
  step_type: string;
  answer_key: string;
  /** 'freeform' means the value was withheld, not missing. See the PII note. */
  value_kind: 'scalar' | 'array_member' | 'freeform';
  answer_value: string | null;
  /**
   * Resolved copy for answer_value, or null when the published step has none —
   * either because the option was retired, or because the variant was published
   * before option copy was carried. Fall back to the code, never hide the row.
   */
  answer_label: string | null;
  in_option_set: boolean | null;
  sessions: number;
  answered_sessions: number;
}

export interface SegmentRow {
  dimension: string;
  bucket: string;
  sessions: number;
  with_activity: number;
  completed: number;
  completion_pct: number;
  median_max_position: number | null;
  p90_max_position: number | null;
  max_position_reached: number;
}

/** Raised when the caller is authenticated but not in cro_analysts. */
export class NotAnAnalystError extends Error {
  constructor() {
    super('Your account is not on the CRO analyst list.');
    this.name = 'NotAnAnalystError';
  }
}

function rethrow(context: string, error: { code?: string; message: string }): never {
  // 42501 is the deliberate RAISE inside every cro_* function, not a fault.
  // Surfacing it as its own type lets the UI say "ask for access" instead of
  // showing an empty dashboard that looks like a quiet day.
  if (error.code === '42501' || /not authorized/i.test(error.message)) {
    throw new NotAnAnalystError();
  }
  throw new Error(`[cro/${context}] ${error.message}`);
}

export async function stepFunnel(
  { from, to }: DateRange,
  filters: Pick<DashboardFilters, 'locale' | 'funnelVariant'>,
  quizVariant: string,
): Promise<CroStepFunnelRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_step_funnel', {
    p_from: from,
    p_to: to,
    p_quiz_variant: quizVariant,
    p_funnel_variant: filters.funnelVariant ?? undefined,
    p_locale: filters.locale ?? undefined,
  });
  if (error) rethrow('step-funnel', error);
  return (data ?? []) as unknown as CroStepFunnelRow[];
}

/**
 * The filter chips.
 *
 * Deliberately NOT filtered by the current selection: it is the escape hatch
 * from a filter that selected an empty window. If it were scoped, choosing a
 * version with no rows would empty the very picker you need to get back out.
 */
export async function funnelSegments({ from, to }: DateRange): Promise<SegmentOptionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_funnel_segments', { p_from: from, p_to: to });
  if (error) rethrow('funnel-segments', error);
  return (data ?? []) as unknown as SegmentOptionRow[];
}

export async function quizCatalog(quizVariant: string): Promise<CatalogRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_quiz_catalog', {
    p_quiz_variant: quizVariant,
  });
  if (error) rethrow('quiz-catalog', error);
  return (data ?? []) as unknown as CatalogRow[];
}

export async function sessionTotals(
  { from, to }: DateRange,
  filters: Pick<DashboardFilters, 'locale' | 'funnelVariant'>,
  quizVariant: string,
): Promise<SessionTotalsRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_session_totals', {
    p_from: from,
    p_to: to,
    p_quiz_variant: quizVariant,
    p_funnel_variant: filters.funnelVariant ?? undefined,
    p_locale: filters.locale ?? undefined,
  });
  if (error) rethrow('session-totals', error);
  return (data ?? []) as unknown as SessionTotalsRow[];
}

export async function liveSessions(
  windowMinutes: number,
  filters: Pick<DashboardFilters, 'locale' | 'funnelVariant' | 'quizVersion'>,
): Promise<LiveRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_live_sessions', {
    p_window_minutes: windowMinutes,
    // Blending versions is safe here: these are per-session counts, not a
    // per-position curve, so nothing merges two versions' step numbering.
    p_quiz_variant: filters.quizVersion ?? undefined,
    p_funnel_variant: filters.funnelVariant ?? undefined,
    p_locale: filters.locale ?? undefined,
  });
  if (error) rethrow('live-sessions', error);
  return (data ?? []) as unknown as LiveRow[];
}

/**
 * `quizVariant` is required by the function itself, not merely by convention:
 * answer keys and the option vocabulary are per-version, so blending two
 * versions blends two vocabularies under one key name.
 */
export async function answerDistribution(
  { from, to }: DateRange,
  quizVariant: string,
  stepId: string | null,
  filters: Pick<DashboardFilters, 'locale' | 'funnelVariant'>,
): Promise<AnswerRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_answer_distribution', {
    p_from: from,
    p_to: to,
    p_quiz_variant: quizVariant,
    p_step_id: stepId ?? undefined,
    p_funnel_variant: filters.funnelVariant ?? undefined,
    p_locale: filters.locale ?? undefined,
  });
  if (error) rethrow('answer-distribution', error);
  return (data ?? []) as unknown as AnswerRow[];
}

export async function segmentBreakdown(
  { from, to }: DateRange,
  dimension: 'locale' | 'device' | 'country' | 'browser' | 'platform' | 'source',
  filters: Pick<DashboardFilters, 'funnelVariant' | 'quizVersion'>,
): Promise<SegmentRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('cro_segment_breakdown', {
    p_from: from,
    p_to: to,
    p_quiz_variant: filters.quizVersion ?? undefined,
    p_funnel_variant: filters.funnelVariant ?? undefined,
    p_dimension: dimension,
  });
  if (error) rethrow('segment-breakdown', error);
  return (data ?? []) as unknown as SegmentRow[];
}

/** Last N days, `to` exclusive at now. */
export function lastNDays(days: number): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The window the filters describe — a rolling preset, or a hand-picked one.
 *
 * The two are deliberately different SHAPES, not one with different numbers. A
 * preset is rolling from this instant, so "last 7 days" at 14:00 means the last
 * 168 hours. A custom window is calendar days in UTC, `from` at midnight and
 * `to` exclusive at the following midnight, so picking 1–14 August includes all
 * of the 14th rather than stopping at whatever time the page was loaded.
 */
export function resolveRange(filters: DashboardFilters): DateRange {
  if (!filters.from || !filters.to) return lastNDays(filters.days);
  const to = new Date(`${filters.to}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: `${filters.from}T00:00:00.000Z`, to: to.toISOString() };
}
