'use client';

import { useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';

type ClaimState = 'idle' | 'claiming' | 'success' | 'error';

export function ClaimPurchasePrompt() {
  const router = useRouter();
  const [state, setState] = useState<ClaimState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleClaim() {
    setState('claiming');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/auth/claim-purchase', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const data = (await res.json()) as { ok?: boolean; authLinked?: boolean; verificationRequired?: boolean; error?: string };
      if (res.ok && data.authLinked) {
        setState('success');
        // Reload to reflect authenticated state
        window.location.reload();
      } else if (res.ok && data.verificationRequired) {
        router.push('/auth/login');
      } else if (res.ok && !data.authLinked) {
        setState('error');
        setErrorMsg('Could not link your purchase right now. You can try again later or use the login page.');
      } else {
        setState('error');
        setErrorMsg(data.error ?? 'Something went wrong. Your purchase is safe  -  try again later.');
      }
    } catch {
      setState('error');
      setErrorMsg('Network error. Your purchase is safe  -  try again later.');
    }
  }

  if (state === 'success') {
    return (
      <div className="rounded-2xl border border-si-primary/20 bg-si-primary/5 px-4 py-4 text-center text-sm text-si-primary">
        Purchase saved to your account!
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-si-outline-variant/30 bg-si-surface-container-low px-4 py-5 text-center">
      <p className="text-sm font-semibold text-si-on-surface">
        Verify your email to access your purchase
      </p>
      <p className="mt-1 text-xs text-si-on-surface-variant">
        Your purchase is saved. Enter the code sent to your checkout email to sign in securely.
      </p>
      <button
        onClick={handleClaim}
        disabled={state === 'claiming'}
        className="mt-3 rounded-full bg-si-primary px-6 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        type="button"
      >
        {state === 'claiming' ? 'Continuing...' : 'Verify my email'}
      </button>
      {state === 'error' && errorMsg && (
        <p className="mt-2 text-xs text-red-600">{errorMsg}</p>
      )}
    </div>
  );
}
