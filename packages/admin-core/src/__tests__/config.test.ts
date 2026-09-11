import { describe, expect, it } from 'vitest';
import { defineAdminConfig, validateAdminConfig, type AdminProjectConfig } from '../config';

const valid: AdminProjectConfig = {
  version: 1,
  project: { defaultLabel: 'Project', defaultAppPath: '/app' },
  authentication: {
    otpRequestRateLimit: { requests: 5, windowSeconds: 300 },
  },
  modules: {
    sessions: true,
    funnel: true,
    revenue: true,
    subscriptions: true,
    customers: true,
    offers: true,
    support: true,
    audit: true,
    health: true,
  },
  analytics: {
    adapter: 'database-provider',
    paymentEnvironment: 'production',
    baseCurrency: 'EUR',
    trialMaturityDays: 7,
    mainSubscriptionProductCodes: ['MAIN_SUB'],
    recurringOffers: [],
  },
  support: {
    adapter: 'database-provider',
    enabledActions: ['send_login_code'],
    maxMatchesPerSource: 250,
    lookupRateLimit: { requests: 30, windowSeconds: 300 },
    actionRateLimit: { requests: 10, windowSeconds: 300 },
  },
};

describe('admin project config', () => {
  it('accepts and freezes a complete project manifest', () => {
    expect(defineAdminConfig(valid)).toEqual(valid);
    expect(Object.isFrozen(defineAdminConfig(valid))).toBe(true);
  });

  it('rejects unsafe app paths and missing subscription identifiers', () => {
    const invalid = {
      ...valid,
      project: { ...valid.project, defaultAppPath: '//external.example' as `/${string}` },
      analytics: { ...valid.analytics, mainSubscriptionProductCodes: [] },
    };
    expect(validateAdminConfig(invalid).join(' ')).toMatch(/local absolute path/);
    expect(validateAdminConfig(invalid).join(' ')).toMatch(/subscription product code/);
  });
});
