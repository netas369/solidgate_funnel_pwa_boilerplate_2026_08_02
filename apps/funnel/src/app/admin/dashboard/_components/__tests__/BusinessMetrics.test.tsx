import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RevenueClient } from '../RevenueClient';
import { SubscriptionsClient } from '../SubscriptionsClient';

vi.mock('../charts/TimeSeriesLine', () => ({
  TimeSeriesLine: () => null,
}));

describe('admin business metrics', () => {
  it('renders trial conversion and renewal success percentages per locale', () => {
    render(
      <SubscriptionsClient
        initialData={{
          cohort: { cohortSize: 4, converted: 3, ratePct: 75 },
          rolling: { numerator: 3, denominator: 4, ratePct: 75 },
          recurringOto: {
            activeCount: 0,
            estimatedMrrEurCents: 0,
            renewalRevenueEurCents: 0,
          },
          statusBreakdown: {
            trialing: 1,
            active: 3,
            pastDue: 0,
            canceled: 0,
            other: 0,
            total: 4,
          },
          variantBreakdown: {
            main: 4,
            special1eur: 0,
            specialFree: 0,
            legacy: 0,
            total: 4,
          },
          localePerformance: {
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
            ],
            warnings: [],
            trialCohortMaturedThrough: '2026-05-25T00:00:00.000Z',
          },
        }}
      />,
    );

    expect(screen.getByText('Subscription performance by locale')).toBeTruthy();
    expect(screen.getByText('en')).toBeTruthy();
    expect(screen.getAllByText('75.0%').length).toBeGreaterThan(0);
    expect(screen.getByText('80.0%')).toBeTruthy();
  });

  it('renders average realized customer LTV with its population and net total', () => {
    render(
      <RevenueClient
        initialData={{
          status: 'ready',
          warnings: [],
          source: 'supabase-solidgate',
          calculatedAt: '2026-06-01T00:00:00.000Z',
          dataThrough: '2026-06-01T00:00:00.000Z',
          data: {
            oneTimeEur: 1000,
            renewalEur: 500,
            byCurrency: { EUR: 1000 },
            timeSeries: [],
            averageCustomerLtv: {
              averageNetLtvEurCents: 1450,
              customerCount: 2,
              totalNetRevenueEurCents: 2900,
              warning: null,
            },
          },
        }}
      />,
    );

    expect(screen.getByText('Average customer LTV (EUR)')).toBeTruthy();
    expect(screen.getByText('€14.50')).toBeTruthy();
    expect(screen.getByText(/2 paying customers/)).toBeTruthy();
    expect(screen.getByText(/€29 net lifetime revenue/)).toBeTruthy();
  });
});
