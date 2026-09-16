// "Update your card" — the recovery page for a subscription whose rebill
// failed. The existing billable subscription can recover even after grace
// expires or when an add-on has no grace. Card replacement grants no access.
//
// Solidgate needs no SetupIntent and no PSP round-trip here: the card is
// tokenised by a zero-amount auth in the browser, so render and stop.

import { redirect } from '@repo/i18n/navigation';
import { createClient } from '@repo/shared/supabase/server';
import { getRecoverableSubscription } from '@repo/shared/grace-period';
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
    redirect({ href: '/login', locale: locale as 'en' });
  }

  const recoverable = await getRecoverableSubscription(user!.id);
  if (!recoverable) {
    redirect({ href: '/dashboard', locale: locale as 'en' });
  }

  return <SolidgateUpdateCard productName={recoverable!.productName} />;
}
