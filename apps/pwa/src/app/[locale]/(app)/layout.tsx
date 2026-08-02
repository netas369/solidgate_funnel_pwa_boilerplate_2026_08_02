// Authenticated PWA shell. Renders the grace-period banner above children
// when the signed-in user has an active past_due+grace entitlement (and is
// NOT currently on the /billing/update-payment page where the banner would
// be redundant).
//
// pathname detection note: Next.js App Router does not expose pathname to
// layouts directly. We rely on the `x-pathname` header set by middleware
// (or `x-invoke-path` from the framework). If neither is present in this
// runtime, the banner simply renders on the update-payment page too — that
// is a graceful fallback, not a correctness issue (the page still works).

import { headers } from 'next/headers';
import { Suspense } from 'react';
import { createClient } from '@repo/shared/supabase/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { getActiveGracePeriodSubscription } from '@repo/shared/grace-period';
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

  // Solidgate UAT item 8: after a hard cancel the member area must lock, not
  // just the add-ons. 'revoked' means the newest app-access entitlement (main
  // sub or lifetime) is an explicit tombstone with nothing live left. Lapsed
  // expiry alone or no rows at all stays admitted — the renewal boundary and
  // the fresh-buyer provisioning race must never brick a paying customer.
  if (user?.id && (await appAccessEntitlementState(user.id)) === 'revoked') {
    return <SubscriptionEndedScreen />;
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

  // Suppress the banner on the /billing/update-payment page itself.
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? hdrs.get('x-invoke-path') ?? '';
  const onUpdatePaymentPage = pathname.includes('/billing/update-payment');
  const showBanner = !!grace && !onUpdatePaymentPage;
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
