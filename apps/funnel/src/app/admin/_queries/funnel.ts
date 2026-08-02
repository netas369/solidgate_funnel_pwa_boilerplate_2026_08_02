// Quiz funnel analytics — server-only aggregations for the admin Funnel tab.
//
// Three lenses:
//  - quizStepFunnel(): per-step completion counts → quiz drop-off curve.
//  - funnelStageSummary(): top-line stages (started → leads → completed).
//  - localeBreakdown(): sessions / leads / subscriptions per locale.
//
// Step-level data comes from funnel_events rows with event_type='step_completed'
// (emitted by use-quiz-navigation.ts on every step advance, deduped per step
// per session-load). step_number on those rows is the 1-based quiz position
// from quizConfig.stepPositions.
//
// Never import this from a 'use client' module — it uses the service-role
// admin client. (Type-only imports from a client component are fine.)

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { quizConfig } from '@/features/quiz/config/quiz-config';
import { countLeadsInRange } from './leads';
import type { DateRange } from './_shared';

/** One row of the step-by-step quiz funnel. */
export interface StepFunnelRow {
  /** 1-based quiz position (matches funnel_events.step_number). */
  position: number;
  stepId: string;
  /** Step kind from quiz-config: radio, info_box, input_group, email_capture… */
  type: string;
  /** Funnel phase (e.g. "intro", "birth"), derived from the config phase key. */
  phase: string;
  /** step_completed events recorded for this step in the window. */
  completed: number;
  /** completed[prev] − completed[this], clamped to ≥ 0. */
  dropFromPrev: number;
  /** dropFromPrev as a % of the previous step's completions (1 dp). */
  dropPctFromPrev: number;
}

/** Top-line funnel stages. */
export interface FunnelStageSummary {
  /** Quiz sessions created in the window (source='quiz'). */
  started: number;
  /** lead_captured events in the window (matches the Leads KPI). */
  leads: number;
  /** quiz_completed events in the window. */
  quizCompleted: number;
}

/** Per-locale rollup combining sessions, leads and subscriptions. */
export interface LocaleBreakdownRow {
  locale: string;
  sessions: number;
  /** Sessions that captured an email. */
  leads: number;
  /** leads / sessions as a % (1 dp). */
  leadRatePct: number;
  /** Subscription orders attributed to this locale. */
  subscriptions: number;
}

interface StepMeta {
  position: number;
  stepId: string;
  type: string;
  phase: string;
}

// Static quiz layout, derived once from the config (the source of truth for
// step ordering, types and phases). Sorted by position, ascending.
//
// Two steps MAY share a position: that is how quiz-config encodes a branch
// (a visitor traverses one alternative, not both). Consumers detect branches
// by looking for a repeated `position` — see FunnelClient.
const STEP_META: StepMeta[] = quizConfig.steps
  .map((s) => ({
    position: quizConfig.stepPositions[s.stepId] ?? 0,
    stepId: s.stepId,
    type: String(s.type),
    phase: String((s as { phase?: string }).phase ?? '').replace(/^phases\./, ''),
  }))
  .filter((s) => s.position > 0)
  .sort((a, b) => a.position - b.position);

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Count step_completed events for one step position in the window. */
async function countStepCompletions(
  from: string,
  to: string,
  position: number,
): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('funnel_events')
    .select('*', { count: 'exact', head: true })
    .eq('event_type', 'step_completed')
    .eq('step_number', position)
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error(
      `[admin/funnel] countStepCompletions(step ${position}) failed:`,
      error.message,
    );
    return 0;
  }
  return count ?? 0;
}

/**
 * Per-step quiz funnel. One small COUNT query per step, all in parallel —
 * cheap and cap-free, vs. pulling every funnel_events row.
 *
 * Note: where two config steps share a position (a branch), raw per-step
 * counts dip there even when nobody actually dropped.
 */
export async function quizStepFunnel({
  from,
  to,
}: DateRange): Promise<StepFunnelRow[]> {
  const counts = await Promise.all(
    STEP_META.map((s) => countStepCompletions(from, to, s.position)),
  );

  const rows: StepFunnelRow[] = [];
  for (let i = 0; i < STEP_META.length; i++) {
    const meta = STEP_META[i];
    const completed = counts[i];
    const prev = i > 0 ? counts[i - 1] : null;
    const drop = prev !== null ? Math.max(0, prev - completed) : 0;
    const dropPct = prev && prev > 0 ? round1((drop / prev) * 100) : 0;
    rows.push({
      position: meta.position,
      stepId: meta.stepId,
      type: meta.type,
      phase: meta.phase,
      completed,
      dropFromPrev: drop,
      dropPctFromPrev: dropPct,
    });
  }
  return rows;
}

/** Quiz sessions created in the window. */
async function countQuizSessions(from: string, to: string): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'quiz')
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error('[admin/funnel] countQuizSessions failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

/** quiz_completed events in the window. */
async function countQuizCompleted(from: string, to: string): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('funnel_events')
    .select('*', { count: 'exact', head: true })
    .eq('event_type', 'quiz_completed')
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error('[admin/funnel] countQuizCompleted failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

export async function funnelStageSummary(
  range: DateRange,
): Promise<FunnelStageSummary> {
  const [started, leads, quizCompleted] = await Promise.all([
    countQuizSessions(range.from, range.to),
    countLeadsInRange(range),
    countQuizCompleted(range.from, range.to),
  ]);
  return { started, leads, quizCompleted };
}

/** Pull the locale off a PostgREST embedded `sessions` relation. */
function embeddedLocale(value: unknown): string {
  if (Array.isArray(value)) {
    return (value[0] as { locale?: string } | undefined)?.locale ?? 'unknown';
  }
  return (value as { locale?: string } | null)?.locale ?? 'unknown';
}

export async function localeBreakdown({
  from,
  to,
}: DateRange): Promise<LocaleBreakdownRow[]> {
  const admin = getSupabaseAdminClient();

  const [sessionsRes, leadsRes, subsRes] = await Promise.all([
    admin
      .from('sessions')
      .select('locale')
      .eq('source', 'quiz')
      .gte('created_at', from)
      .lt('created_at', to),
    admin
      .from('sessions')
      .select('locale')
      .eq('source', 'quiz')
      .not('email', 'is', null)
      .gte('created_at', from)
      .lt('created_at', to),
    // Subscription orders, with the originating session's locale embedded.
    // A subscription order is exactly one that carries a Solidgate
    // subscription id; one-time OTO orders never do.
    admin
      .from('orders')
      .select('sessions(locale)')
      .eq('payment_environment', 'production')
      .not('solidgate_subscription_id', 'is', null)
      .gte('created_at', from)
      .lt('created_at', to),
  ]);

  if (sessionsRes.error) {
    console.error('[admin/funnel] localeBreakdown sessions failed:', sessionsRes.error.message);
  }
  if (leadsRes.error) {
    console.error('[admin/funnel] localeBreakdown leads failed:', leadsRes.error.message);
  }
  if (subsRes.error) {
    console.error('[admin/funnel] localeBreakdown subs failed:', subsRes.error.message);
  }

  const sessionCounts = new Map<string, number>();
  const leadCounts = new Map<string, number>();
  const subCounts = new Map<string, number>();

  for (const row of sessionsRes.data ?? []) {
    const k = (row.locale as string) ?? 'unknown';
    sessionCounts.set(k, (sessionCounts.get(k) ?? 0) + 1);
  }
  for (const row of leadsRes.data ?? []) {
    const k = (row.locale as string) ?? 'unknown';
    leadCounts.set(k, (leadCounts.get(k) ?? 0) + 1);
  }
  for (const row of subsRes.data ?? []) {
    const k = embeddedLocale((row as { sessions?: unknown }).sessions);
    subCounts.set(k, (subCounts.get(k) ?? 0) + 1);
  }

  const locales = new Set<string>([
    ...sessionCounts.keys(),
    ...leadCounts.keys(),
    ...subCounts.keys(),
  ]);

  return [...locales]
    .map((locale) => {
      const sessions = sessionCounts.get(locale) ?? 0;
      const leads = leadCounts.get(locale) ?? 0;
      return {
        locale,
        sessions,
        leads,
        leadRatePct: sessions > 0 ? round1((leads / sessions) * 100) : 0,
        subscriptions: subCounts.get(locale) ?? 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}
