// "Update your card" — the recovery page for a subscription whose rebill
// failed. Render-blocking on a real grace match: we redirect to /dashboard if
// the user has no grace subscription, so the form never renders for someone
// with nothing to recover.
//
// Solidgate needs no SetupIntent and no PSP round-trip here: the card is
// tokenised by a zero-amount auth in the browser, so render and stop.

import { redirect } from '@repo/i18n/navigation';
import { createClient } from '@repo/shared/supabase/server';
import { getActiveGracePeriodSubscription } from '@repo/shared/grace-period';
import { SolidgateUpdateCard } from './_components/SolidgateUpdateCard';

export default async function UpdatePaymentPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/auth/login', locale: locale as 'en' });
  }

  const grace = await getActiveGracePeriodSubscription(user!.id);
  if (!grace) {
    redirect({ href: '/dashboard', locale: locale as 'en' });
  }

  return <SolidgateUpdateCard productName={grace!.productName} />;
}
