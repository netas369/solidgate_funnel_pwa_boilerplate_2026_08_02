import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAdminAccess, validateAdminConfig } from '@repo/admin-core';
import { adminConfig } from '../apps/funnel/src/admin.config';

const structureOnly = process.argv.includes('--structure-only');
const root = process.cwd();
const errors = validateAdminConfig(adminConfig);

const supportedAnalyticsAdapters = new Set(['supabase-solidgate']);
const supportedSupportAdapters = new Set(['supabase-solidgate']);
if (!supportedAnalyticsAdapters.has(adminConfig.analytics.adapter)) {
  errors.push(`analytics adapter is not registered: ${adminConfig.analytics.adapter}`);
}
if (!supportedSupportAdapters.has(adminConfig.support.adapter)) {
  errors.push(`support adapter is not registered: ${adminConfig.support.adapter}`);
}
if (
  adminConfig.analytics.adapter === 'supabase-solidgate' &&
  adminConfig.analytics.baseCurrency !== 'EUR'
) {
  errors.push('supabase-solidgate analytics adapter requires baseCurrency EUR');
}

const requiredFiles = [
  'apps/funnel/src/admin.config.ts',
  'apps/funnel/src/features/admin/adapters/supabase-solidgate.ts',
  'supabase/migrations/00002_admin_support.sql',
  'supabase/migrations/00003_admin_metrics.sql',
  'supabase/migrations/00004_admin_core.sql',
];
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) errors.push(`required file is missing: ${file}`);
}

const generatedTypesPath = resolve(root, 'packages/shared/src/types/database.ts');
if (existsSync(generatedTypesPath)) {
  const generatedTypes = readFileSync(generatedTypesPath, 'utf8');
  for (const symbol of [
    'admin_customer_ltv_by_currency_v2',
    'admin_subscription_performance_by_locale_v2',
    'consume_admin_rate_limit',
    'idempotency_key',
  ]) {
    if (!generatedTypes.includes(symbol)) {
      errors.push(`generated database types are missing ${symbol}`);
    }
  }
}

if (!structureOnly) {
  const access = parseAdminAccess();
  errors.push(...access.errors);
  if (access.entries.length === 0) {
    errors.push('ADMIN_ACCESS or legacy ADMIN_EMAILS must grant at least one staff account');
  }

  const fxRaw = process.env.ADMIN_FX_RATES?.trim();
  if (fxRaw) {
    for (const pair of fxRaw.split(',')) {
      const [currency, rawRate, ...rest] = pair.split(':');
      const rate = Number(rawRate);
      if (
        rest.length > 0 ||
        !/^[A-Za-z]{3}$/.test(currency?.trim() ?? '') ||
        !Number.isFinite(rate) ||
        rate <= 0
      ) {
        errors.push(`invalid ADMIN_FX_RATES entry: ${pair.trim() || '<empty>'}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Admin verification failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Admin verification passed (${structureOnly ? 'structure only' : 'configuration + structure'}).`,
  );
}
