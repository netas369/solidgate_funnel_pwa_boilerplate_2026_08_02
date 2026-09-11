import { beforeEach, describe, expect, it, vi } from 'vitest';

const RANGE = {
  from: '2026-05-01T00:00:00Z',
  to: '2026-06-01T00:00:00Z',
};

describe('subscriptionPerformanceByLocale', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  });

  it('calculates percentages from database-deduplicated locale cohorts', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          locale: 'en',
          trial_starts: 4,
          trial_conversions: 3,
          renewal_invoices: 10,
          first_attempt_successful_renewals: 6,
          successful_renewals: 8,
          recovered_renewals: 2,
        },
        {
          locale: 'lt',
          trial_starts: 3,
          trial_conversions: 1,
          renewal_invoices: 0,
          first_attempt_successful_renewals: 0,
          successful_renewals: 0,
          recovered_renewals: 0,
        },
      ],
      error: null,
    });
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({ rpc }),
    }));

    const { subscriptionPerformanceByLocale } = await import('../subscriptions');
    const result = await subscriptionPerformanceByLocale(RANGE);

    expect(result).toEqual({
      locales: [
        {
          locale: 'en',
          trialStarts: 4,
          trialConversions: 3,
          trialConversionPct: 75,
          renewalInvoices: 10,
          firstAttemptSuccessfulRenewals: 6,
          firstAttemptRenewalSuccessPct: 60,
          successfulRenewals: 8,
          recoveredRenewals: 2,
          renewalSuccessPct: 80,
        },
        {
          locale: 'lt',
          trialStarts: 3,
          trialConversions: 1,
          trialConversionPct: 33.3,
          renewalInvoices: 0,
          firstAttemptSuccessfulRenewals: 0,
          firstAttemptRenewalSuccessPct: 0,
          successfulRenewals: 0,
          recoveredRenewals: 0,
          renewalSuccessPct: 0,
        },
      ],
      warnings: [],
      trialCohortMaturedThrough: expect.any(String),
    });
    expect(rpc).toHaveBeenCalledWith(
      'admin_subscription_performance_by_locale_v2',
      expect.objectContaining({
        p_from: RANGE.from,
        p_to: RANGE.to,
        p_payment_environment: 'production',
        p_trial_maturity_days: 7,
      }),
    );
  });

  it('returns a visible warning when the admin metrics migration is unavailable', async () => {
    vi.doMock('@repo/shared/supabase/admin', () => ({
      getSupabaseAdminClient: () => ({
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'function does not exist' },
        }),
      }),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { subscriptionPerformanceByLocale } = await import('../subscriptions');
    const result = await subscriptionPerformanceByLocale(RANGE);

    expect(result.locales).toEqual([]);
    expect(result.warnings.join(' ')).toContain('admin core migration');
  });
});
