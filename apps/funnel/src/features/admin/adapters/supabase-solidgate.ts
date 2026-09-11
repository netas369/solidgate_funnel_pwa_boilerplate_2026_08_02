import type {
  AdminAnalyticsAdapter,
  AdminSupportAdapter,
} from '@repo/admin-core/adapters';
import {
  partialAdminData,
  readyAdminData,
  unavailableAdminData,
} from '@repo/admin-core/result';
import { lookupCustomerSupportReport } from '@/app/admin/_queries/support';
import type { SupportReport } from '@/features/admin/support/types';
import {
  averageCustomerLtvEur,
  grossRevenueInEurInRange,
  revenueByCurrencyInRange,
  renewalRevenueInEur,
  revenueTimeSeriesInEur,
  type AverageCustomerLtvMetric,
} from '@/app/admin/_queries/revenue';

export interface SupabaseSolidgateRevenueSnapshot {
  oneTimeEur: number;
  renewalEur: number;
  byCurrency: Record<string, number>;
  timeSeries: Array<{ date: string; value: number }>;
  averageCustomerLtv: AverageCustomerLtvMetric;
}

const EMPTY_REVENUE: SupabaseSolidgateRevenueSnapshot = {
  oneTimeEur: 0,
  renewalEur: 0,
  byCurrency: {},
  timeSeries: [],
  averageCustomerLtv: {
    averageNetLtvEurCents: 0,
    customerCount: 0,
    totalNetRevenueEurCents: 0,
    warning: 'Average customer LTV is unavailable.',
  },
};

const ADAPTER_ID = 'supabase-solidgate';

export const supabaseSolidgateRevenueAdapter: AdminAnalyticsAdapter<SupabaseSolidgateRevenueSnapshot> = {
  id: ADAPTER_ID,
  async readSnapshot(range, config) {
    if (config.analytics.adapter !== ADAPTER_ID) {
      return unavailableAdminData(
        EMPTY_REVENUE,
        {
          code: 'analytics_adapter_mismatch',
          message: `Configured analytics adapter ${config.analytics.adapter} is not registered.`,
        },
        { source: ADAPTER_ID, dataThrough: range.to },
      );
    }
    try {
      const [oneTimeEur, renewalEur, byCurrency, timeSeries, averageCustomerLtv] =
        await Promise.all([
          grossRevenueInEurInRange(range),
          renewalRevenueInEur(range),
          revenueByCurrencyInRange(range),
          revenueTimeSeriesInEur(range),
          averageCustomerLtvEur(),
        ]);
      const snapshot = {
        oneTimeEur,
        renewalEur,
        byCurrency,
        timeSeries,
        averageCustomerLtv,
      };
      if (averageCustomerLtv.warning) {
        return partialAdminData(
          snapshot,
          [{ code: 'ltv_unavailable', message: averageCustomerLtv.warning }],
          { source: ADAPTER_ID, dataThrough: range.to },
        );
      }
      return readyAdminData(snapshot, { source: ADAPTER_ID, dataThrough: range.to });
    } catch (error) {
      console.error(
        '[admin/revenue] adapter snapshot failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      return unavailableAdminData(
        EMPTY_REVENUE,
        {
          code: 'revenue_unavailable',
          message:
            error instanceof Error && error.name === 'MissingAdminFxRateError'
              ? `${error.message}. Configure ADMIN_FX_RATES.`
              : 'Revenue data could not be read. Check the database and adapter configuration.',
        },
        { source: ADAPTER_ID, dataThrough: range.to },
      );
    }
  },
};

export const supabaseSolidgateSupportAdapter: AdminSupportAdapter<SupportReport> = {
  id: 'supabase-solidgate',
  lookupExactEmail(email) {
    return lookupCustomerSupportReport(email);
  },
};
