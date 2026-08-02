import { beforeEach, describe, expect, it, vi } from 'vitest';

// ../refetch-funnel exposes refetchFunnel(range) which:
//   - throws Forbidden when the caller fails isAdminEmail() (defense-in-depth)
//   - returns the { steps, summary, byLocale } payload for a valid range

const VALID_RANGE = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-05-08T00:00:00.000Z',
};

describe('refetchFunnel server action', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-svc';
  });

  it('throws Forbidden when the caller is not an admin', async () => {
    vi.doMock('@repo/shared/supabase/server', () => ({
      createClient: vi.fn(async () => ({
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: { email: 'intruder@example.com' } },
            error: null,
          })),
        },
      })),
    }));
    // Mock the query module so an accidental call cannot silently succeed.
    vi.doMock('../../../_queries/funnel', () => ({
      quizStepFunnel: vi.fn().mockResolvedValue([]),
      funnelStageSummary: vi
        .fn()
        .mockResolvedValue({ started: 0, leads: 0, quizCompleted: 0 }),
      localeBreakdown: vi.fn().mockResolvedValue([]),
    }));

    const { refetchFunnel } = await import('../refetch-funnel');
    await expect(refetchFunnel(VALID_RANGE)).rejects.toThrow('Forbidden');
  });

  it('returns {steps, summary, byLocale} for an admin caller', async () => {
    vi.doMock('@repo/shared/supabase/server', () => ({
      createClient: vi.fn(async () => ({
        auth: {
          getUser: vi.fn(async () => ({
            data: { user: { email: 'admin@example.com' } },
            error: null,
          })),
        },
      })),
    }));
    const steps = [
      {
        position: 1,
        stepId: 'step1',
        type: 'info_box',
        phase: 'intro',
        completed: 10,
        dropFromPrev: 0,
        dropPctFromPrev: 0,
      },
    ];
    const summary = { started: 10, leads: 4, quizCompleted: 2 };
    const byLocale = [
      { locale: 'en', sessions: 10, leads: 4, leadRatePct: 40, subscriptions: 1 },
    ];
    vi.doMock('../../../_queries/funnel', () => ({
      quizStepFunnel: vi.fn().mockResolvedValue(steps),
      funnelStageSummary: vi.fn().mockResolvedValue(summary),
      localeBreakdown: vi.fn().mockResolvedValue(byLocale),
    }));

    const { refetchFunnel } = await import('../refetch-funnel');
    const result = await refetchFunnel(VALID_RANGE);
    expect(result).toEqual({ steps, summary, byLocale });
  });
});
