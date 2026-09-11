import { parseAdminAccess, validateAdminConfig } from '@repo/admin-core';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { adminConfig } from '@/admin.config';
import { ADMIN_FX_RATES } from '@/app/admin/_queries/fx';

export type AdminHealthStatus = 'healthy' | 'warning' | 'failed';

export interface AdminHealthCheck {
  id: string;
  label: string;
  status: AdminHealthStatus;
  detail: string;
}

async function schemaChecks(): Promise<AdminHealthCheck[]> {
  const admin = getSupabaseAdminClient();
  const emptyRange = '1970-01-01T00:00:00.000Z';
  const [audit, rateLimits, metrics] = await Promise.all([
    admin.from('support_action_audit').select('id', { head: true, count: 'exact' }),
    admin.from('admin_rate_limit_events').select('id', { head: true, count: 'exact' }),
    admin.rpc('admin_subscription_performance_by_locale_v2', {
      p_from: emptyRange,
      p_to: emptyRange,
      p_main_product_slugs: [...adminConfig.analytics.mainSubscriptionProductCodes],
      p_payment_environment: adminConfig.analytics.paymentEnvironment,
      p_trial_maturity_days: adminConfig.analytics.trialMaturityDays,
    }),
  ]);

  return [
    {
      id: 'support-audit-schema',
      label: 'Support audit schema',
      status: audit.error ? 'failed' : 'healthy',
      detail: audit.error ? 'Audit table is unavailable; actions remain disabled.' : 'Durable action audit is available.',
    },
    {
      id: 'admin-rate-limit-schema',
      label: 'Request protection schema',
      status: rateLimits.error ? 'failed' : 'healthy',
      detail: rateLimits.error ? 'Rate-limit storage is unavailable; protected APIs fail closed.' : 'Rate-limit storage is available.',
    },
    {
      id: 'admin-metrics-schema',
      label: 'Admin metrics schema',
      status: metrics.error ? 'failed' : 'healthy',
      detail: metrics.error ? 'V2 locale metrics RPC is unavailable.' : 'V2 locale metrics RPC is available.',
    },
  ];
}

export async function getAdminHealthChecks(): Promise<AdminHealthCheck[]> {
  const configErrors = validateAdminConfig(adminConfig);
  const access = parseAdminAccess();
  const fxCurrencies = Object.keys(ADMIN_FX_RATES).sort();
  const localChecks: AdminHealthCheck[] = [
    {
      id: 'manifest',
      label: 'Project manifest',
      status: configErrors.length > 0 ? 'failed' : 'healthy',
      detail: configErrors.length > 0 ? configErrors.join(' ') : `Version ${adminConfig.version}; ${adminConfig.analytics.adapter} analytics adapter.`,
    },
    {
      id: 'access',
      label: 'Staff access policy',
      status: access.errors.length > 0 || access.entries.length === 0 ? 'failed' : 'healthy',
      detail:
        access.errors.length > 0
          ? access.errors.join(' ')
          : `${access.entries.length} staff account(s) configured through ${access.source}.`,
    },
    {
      id: 'environment',
      label: 'Payment environment',
      status: 'healthy',
      detail: `Analytics reads only ${adminConfig.analytics.paymentEnvironment}.`,
    },
    {
      id: 'fx',
      label: 'FX configuration',
      status: fxCurrencies.length > 0 ? 'healthy' : 'warning',
      detail:
        fxCurrencies.length > 0
          ? `Configured source currencies: ${fxCurrencies.join(', ')} → ${adminConfig.analytics.baseCurrency}.`
          : `No non-${adminConfig.analytics.baseCurrency} FX rates are configured.`,
    },
  ];

  try {
    return [...localChecks, ...(await schemaChecks())];
  } catch (error) {
    console.error(
      '[admin/health] schema checks failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return [
      ...localChecks,
      {
        id: 'database',
        label: 'Database connectivity',
        status: 'failed',
        detail: 'The admin database could not be reached.',
      },
    ];
  }
}
