export type AdminModuleKey =
  | 'sessions'
  | 'funnel'
  | 'revenue'
  | 'subscriptions'
  | 'customers'
  | 'offers'
  | 'support'
  | 'audit'
  | 'health';

export type AdminSupportActionKey = 'send_login_code' | 'revoke_sessions';

export interface AdminRecurringOfferConfig {
  id: string;
  productCode: string;
  billingInterval: 'day' | 'week' | 'month' | 'year';
  billingIntervalCount: number;
}

export interface AdminProjectConfig {
  version: 1;
  project: {
    defaultLabel: string;
    defaultAppPath: `/${string}`;
  };
  authentication: {
    otpRequestRateLimit: { requests: number; windowSeconds: number };
  };
  modules: Readonly<Record<AdminModuleKey, boolean>>;
  analytics: {
    adapter: string;
    paymentEnvironment: string;
    baseCurrency: string;
    trialMaturityDays: number;
    mainSubscriptionProductCodes: readonly string[];
    recurringOffers: readonly AdminRecurringOfferConfig[];
  };
  support: {
    adapter: string;
    enabledActions: readonly AdminSupportActionKey[];
    maxMatchesPerSource: number;
    lookupRateLimit: { requests: number; windowSeconds: number };
    actionRateLimit: { requests: number; windowSeconds: number };
  };
}

export function defineAdminConfig(config: AdminProjectConfig): AdminProjectConfig {
  const errors = validateAdminConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid admin.config.ts:\n- ${errors.join('\n- ')}`);
  }
  return Object.freeze(config);
}

export function validateAdminConfig(config: AdminProjectConfig): string[] {
  const errors: string[] = [];
  if (config.version !== 1) errors.push('version must be 1');
  if (!config.project.defaultLabel.trim()) errors.push('project.defaultLabel is required');
  if (!config.project.defaultAppPath.startsWith('/') || config.project.defaultAppPath.startsWith('//')) {
    errors.push('project.defaultAppPath must be a local absolute path');
  }
  if (
    !Number.isInteger(config.authentication.otpRequestRateLimit.requests) ||
    config.authentication.otpRequestRateLimit.requests < 1
  ) {
    errors.push('authentication.otpRequestRateLimit.requests must be a positive integer');
  }
  if (
    !Number.isInteger(config.authentication.otpRequestRateLimit.windowSeconds) ||
    config.authentication.otpRequestRateLimit.windowSeconds < 1
  ) {
    errors.push('authentication.otpRequestRateLimit.windowSeconds must be a positive integer');
  }
  if (!config.analytics.adapter.trim()) errors.push('analytics.adapter is required');
  if (!config.analytics.paymentEnvironment.trim()) {
    errors.push('analytics.paymentEnvironment is required');
  }
  if (!/^[A-Z]{3}$/.test(config.analytics.baseCurrency)) {
    errors.push('analytics.baseCurrency must be a three-letter uppercase currency code');
  }
  if (!Number.isInteger(config.analytics.trialMaturityDays) || config.analytics.trialMaturityDays < 0) {
    errors.push('analytics.trialMaturityDays must be a non-negative integer');
  }
  if (
    config.modules.subscriptions &&
    config.analytics.mainSubscriptionProductCodes.length === 0
  ) {
    errors.push('at least one main subscription product code is required');
  }
  if (new Set(config.analytics.mainSubscriptionProductCodes).size !== config.analytics.mainSubscriptionProductCodes.length) {
    errors.push('main subscription product codes must be unique');
  }
  for (const offer of config.analytics.recurringOffers) {
    if (!offer.id.trim() || !offer.productCode.trim()) {
      errors.push('every recurring offer needs an id and productCode');
    }
    if (!Number.isInteger(offer.billingIntervalCount) || offer.billingIntervalCount < 1) {
      errors.push(`recurring offer ${offer.id || '<unknown>'} needs a positive interval count`);
    }
  }
  if (!config.support.adapter.trim()) errors.push('support.adapter is required');
  if (!Number.isInteger(config.support.maxMatchesPerSource) || config.support.maxMatchesPerSource < 1) {
    errors.push('support.maxMatchesPerSource must be a positive integer');
  }
  for (const [name, limit] of [
    ['lookupRateLimit', config.support.lookupRateLimit],
    ['actionRateLimit', config.support.actionRateLimit],
  ] as const) {
    if (!Number.isInteger(limit.requests) || limit.requests < 1) {
      errors.push(`support.${name}.requests must be a positive integer`);
    }
    if (!Number.isInteger(limit.windowSeconds) || limit.windowSeconds < 1) {
      errors.push(`support.${name}.windowSeconds must be a positive integer`);
    }
  }
  if (new Set(config.support.enabledActions).size !== config.support.enabledActions.length) {
    errors.push('support.enabledActions must be unique');
  }
  return errors;
}
