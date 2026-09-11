import { defineAdminConfig } from '@repo/admin-core/config';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';

/**
 * The only project-owned manifest consumed by the shared admin workspace.
 * Adapt a new project here and in its adapter modules; shared admin UI should
 * not contain product names, billing assumptions, or provider identifiers.
 */
export const adminConfig = defineAdminConfig({
  version: 1,
  project: {
    defaultLabel: 'Project',
    defaultAppPath: '/en/dashboard',
  },
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
    adapter: 'supabase-solidgate',
    paymentEnvironment: process.env.ADMIN_PAYMENT_ENVIRONMENT?.trim() || 'production',
    baseCurrency: 'EUR',
    trialMaturityDays: 7,
    mainSubscriptionProductCodes: [SOLIDGATE_PRODUCT_CODES.main],
    recurringOffers: [
      {
        id: 'oto2_addon_weekly',
        productCode: SOLIDGATE_PRODUCT_CODES.addon,
        billingInterval: 'week',
        billingIntervalCount: 1,
      },
    ],
  },
  support: {
    adapter: 'supabase-solidgate',
    enabledActions: ['send_login_code', 'revoke_sessions'],
    maxMatchesPerSource: 250,
    lookupRateLimit: { requests: 30, windowSeconds: 300 },
    actionRateLimit: { requests: 10, windowSeconds: 300 },
  },
});
