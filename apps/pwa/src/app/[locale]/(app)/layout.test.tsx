import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ access: 'active' as 'active' | 'none' | 'revoked' | 'pending' | 'unavailable' }));
vi.mock('@repo/i18n/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@repo/shared/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }) }));
vi.mock('@repo/shared/supabase/admin', () => ({ getSupabaseAdminClient: () => ({ from: () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) }; return chain;
} }) }));
vi.mock('@repo/shared/entitlements', () => ({ appAccessEntitlementState: async () => state.access }));
vi.mock('@repo/shared/grace-period', () => ({ getActiveGracePeriodSubscription: async () => null, getRecoverableSubscription: async () => null }));
vi.mock('@/components/billing/AccessRecoveryScreen', () => ({ AccessRecoveryScreen: () => null }));
vi.mock('@/components/billing/SubscriptionEndedScreen', () => ({ SubscriptionEndedScreen: () => null }));
vi.mock('@/components/billing/grace-period-banner', () => ({ GracePeriodBanner: () => null }));
vi.mock('@/components/analytics/PwaAnalytics', () => ({ PwaAnalytics: () => null }));
vi.mock('@/components/billing/SolidgatePurchaseReturn', () => ({ SolidgatePurchaseReturn: () => null }));
import AppLayout from './layout';
import { AccessRecoveryScreen } from '@/components/billing/AccessRecoveryScreen';
import { SubscriptionEndedScreen } from '@/components/billing/SubscriptionEndedScreen';

describe('paid content shell', () => {
  it.each(['none', 'pending', 'unavailable'] as const)('never renders paid children for %s access', async (access) => {
    state.access = access;
    const result = await AppLayout({ children: <div>private content</div>, params: Promise.resolve({ locale: 'en' }) });
    expect(result.type).toBe(AccessRecoveryScreen);
    expect(result.props).toEqual({ state: access, canRecoverBilling: false });
  });
  it('locks revoked access', async () => {
    state.access = 'revoked';
    const result = await AppLayout({ children: <div>private content</div>, params: Promise.resolve({ locale: 'en' }) });
    expect(result.type).toBe(SubscriptionEndedScreen);
    expect(result.props.canRecoverBilling).toBe(false);
  });
  it('renders paid children only for an active entitlement', async () => {
    state.access = 'active';
    const children = <div>private content</div>;
    const result = await AppLayout({ children, params: Promise.resolve({ locale: 'en' }) });
    expect(result.type).toBe(React.Fragment);
    expect(result.props.children).toContain(children);
  });
});
