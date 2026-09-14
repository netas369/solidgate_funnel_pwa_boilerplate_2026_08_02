"use client";

import { useEffect } from 'react';
import { useRouter, Link } from '@repo/i18n/navigation';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

export function AccessRecoveryScreen({ state, canRecoverBilling = false }: { state: 'pending' | 'none' | 'unavailable'; canRecoverBilling?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (state !== 'pending') return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [router, state]);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6 text-center">
      <h1 className="text-2xl font-semibold">{state === 'pending' ? 'Confirming your access' : 'Your access needs attention'}</h1>
      <p>{state === 'pending'
        ? 'We are waiting for your payment confirmation. This page will refresh automatically.'
        : state === 'unavailable'
          ? 'We could not check your subscription. Please retry in a moment.'
          : canRecoverBilling
            ? 'Your membership is not active. Update your payment method for the existing subscription.'
            : 'There is no active membership on this account. Contact support to review your purchase or restore your membership.'}</p>
      <button type="button" onClick={() => router.refresh()} className="rounded border p-3">Check again</button>
      {canRecoverBilling && <Link href="/billing/update-payment" className="underline">Update payment method</Link>}
      <a href={`mailto:${BOILERPLATE_BRAND.supportEmail}`} className="underline">Contact support</a>
      <Link href="/login" className="underline">Use another account</Link>
    </main>
  );
}
