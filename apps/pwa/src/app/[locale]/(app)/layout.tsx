// Authenticated paid-content shell. Billing recovery is a sibling route group,
// so it remains reachable without relying on client-supplied pathname headers.

import { redirect } from '@repo/i18n/navigation';
import { AccessRecoveryScreen } from '@/components/billing/AccessRecoveryScreen';
import { Suspense } from 'react';
import { createClient } from '@repo/shared/supabase/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { getActiveGracePeriodSubscription, getRecoverableSubscription } from '@repo/shared/grace-period';
import { appAccessEntitlementState } from '@repo/shared/entitlements';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { GracePeriodBanner } from '@/components/billing/grace-period-banner';
import { SubscriptionEndedScreen } from '@/components/billing/SubscriptionEndedScreen';
import { PwaAnalytics } from '@/components/analytics/PwaAnalytics';
import { SolidgatePurchaseReturn } from '@/components/billing/SolidgatePurchaseReturn';
import { normalizeAcquisitionUtm } from '@/lib/analytics/acquisition';

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect({ href: '/login', locale: locale as 'en' });
  const access = await appAccessEntitlementState(user!.id);
  // Billing recovery has its own authenticated route group outside this gate.
  if (access !== 'active') {
    let canRecoverBilling = false;
    if (access !== 'unavailable') {
      try {
        canRecoverBilling = Boolean(await getRecoverableSubscription(user!.id, { mainOnly: true }));
      } catch {
        console.error('[pwa/access] unable to check billing recovery');
      }
    }
    return access === 'revoked'
      ? <SubscriptionEndedScreen canRecoverBilling={canRecoverBilling} />
      : <AccessRecoveryScreen state={access} canRecoverBilling={canRecoverBilling} />;
  }

  const grace = user?.id ? await getActiveGracePeriodSubscription(user.id) : null;
  let acquisition = {};
  if (user?.id) {
    const { data, error } = await getSupabaseAdminClient()
      .from('user_acquisition_attribution')
      .select('utm_source,utm_medium,utm_campaign,utm_content,utm_term')
      .eq('payment_environment', currentPaymentEnvironment())
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      console.error('[pwa/analytics] acquisition lookup failed:', error.message);
    } else {
      acquisition = normalizeAcquisitionUtm(data);
    }
  }

  const showBanner = !!grace;
  const analytics = user?.id ? (
    <Suspense fallback={null}>
      <PwaAnalytics userId={user.id} locale={locale} acquisition={acquisition} />
    </Suspense>
  ) : null;
  const paymentReturn = user?.id ? (
    <Suspense fallback={null}>
      <SolidgatePurchaseReturn />
    </Suspense>
  ) : null;

  // Preserve the prior `<>{children}</>` shape when no banner is needed, so
  // existing dashboard layouts/scroll positions don't regress.
  if (!showBanner) {
    return (
      <>
        {children}
        {paymentReturn}
        {analytics}
      </>
    );
  }

  return (
    <>
      <GracePeriodBanner
        expiresAt={grace!.expiresAt}
        productName={grace!.productName}
        locale={locale}
      />
      <div className="pt-20">{children}</div>
      {paymentReturn}
      {analytics}
    </>
  );
}
