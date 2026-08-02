import { beforeEach, describe, expect, it, vi } from 'vitest';

// Covers ../funnel: quizStepFunnel (per-step drop-off math),
// funnelStageSummary (stage aggregation) and localeBreakdown (per-locale
// merge of sessions / leads / subscriptions).

const RANGE = { from: '2026-05-01T00:00:00Z', to: '2026-05-08T00:00:00Z' };

/**
 * Minimal thenable PostgREST builder: every chain method returns the builder,
 * and awaiting it resolves to `result`. Length-agnostic, so it covers every
 * query shape in funnel.ts without per-method wiring.
 */
function thenable(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'not', 'ilike', 'is', 'in', 'or']) {
    b[m] = vi.fn(() => b);
  }
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return b;
}

describe('funnel queries', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it('quizStepFunnel computes per-step completions and drop-off', async () => {
    // One count per configured quiz step (the quiz config is the source of
    // truth for how many there are): flat-ish with a sharp 50% drop at step 3.
    const { quizConfig } = await import('@/features/quiz/config/quiz-config');
    const stepCount = quizConfig.steps.filter(
      (s) => (quizConfig.stepPositions[s.stepId] ?? 0) > 0,
    ).length;
    const counts = Array.from({ length: stepCount }, (_, i) => {
      if (i === 0) return 100;
      if (i === 1) return 90;
      if (i === 2) return 45;
      return Math.max(0, 45 - (i - 2));
    });
    let call = 0;
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn((table: string) => {
          expect(table).toBe('funnel_events');
          return thenable({ count: counts[call++], error: null });
        }),
      }),
    }));

    const { quizStepFunnel } = await import('../funnel');
    const rows = await quizStepFunnel(RANGE);

    expect(rows).toHaveLength(stepCount);
    expect(rows[0]!.position).toBe(1);
    expect(rows[0]!.completed).toBe(100);
    expect(rows[0]!.dropFromPrev).toBe(0);

    expect(rows[1]!.completed).toBe(90);
    expect(rows[1]!.dropFromPrev).toBe(10);
    expect(rows[1]!.dropPctFromPrev).toBe(10);

    expect(rows[2]!.completed).toBe(45);
    expect(rows[2]!.dropFromPrev).toBe(45);
    expect(rows[2]!.dropPctFromPrev).toBe(50);
  });

  it('funnelStageSummary aggregates started, leads and completed', async () => {
    // from() call order: sessions (started) → funnel_events (leads via
    // countLeadsInRange) → funnel_events (quiz_completed).
    const results = [
      { count: 200, error: null },
      { count: 60, error: null },
      { count: 25, error: null },
    ];
    let call = 0;
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn(() => thenable(results[call++])),
      }),
    }));

    const { funnelStageSummary } = await import('../funnel');
    const summary = await funnelStageSummary(RANGE);
    expect(summary).toEqual({ started: 200, leads: 60, quizCompleted: 25 });
  });

  it('localeBreakdown merges sessions, leads and subscriptions per locale', async () => {
    // from() call order: sessions → sessions (leads) → orders (subs).
    const results = [
      { data: [{ locale: 'en' }, { locale: 'en' }, { locale: 'cs' }], error: null },
      { data: [{ locale: 'en' }], error: null },
      {
        data: [{ sessions: { locale: 'en' } }, { sessions: { locale: 'cs' } }],
        error: null,
      },
    ];
    let call = 0;
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        from: vi.fn(() => thenable(results[call++])),
      }),
    }));

    const { localeBreakdown } = await import('../funnel');
    const rows = await localeBreakdown(RANGE);

    const en = rows.find((r) => r.locale === 'en')!;
    const cs = rows.find((r) => r.locale === 'cs')!;
    expect(en).toEqual({
      locale: 'en',
      sessions: 2,
      leads: 1,
      leadRatePct: 50,
      subscriptions: 1,
    });
    expect(cs).toEqual({
      locale: 'cs',
      sessions: 1,
      leads: 0,
      leadRatePct: 0,
      subscriptions: 1,
    });
    // Sorted desc by sessions.
    expect(rows[0]!.sessions).toBeGreaterThanOrEqual(
      rows[rows.length - 1]!.sessions,
    );
  });
});
