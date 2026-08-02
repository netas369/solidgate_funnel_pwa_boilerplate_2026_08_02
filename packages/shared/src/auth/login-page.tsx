'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BOILERPLATE_BRAND } from '../boilerplate-brand';
import { OtpInput } from './otp-input';

const GENERIC_SUCCESS_MESSAGE =
  `If that email is linked to a ${BOILERPLATE_BRAND.name} account, check your inbox for a 6-digit code.`;

export interface LoginPageProps {
  /**
   * Controls post-login redirect behavior:
   * - "funnel": uses server-resolved redirect (resolvePostLoginDestination)
   * - "pwa": always redirects to /dashboard
   */
  appType: 'funnel' | 'pwa';
}

export function LoginPage({ appType }: LoginPageProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setCooldown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function requestOtp() {
    setSending(true);
    setError('');

    try {
      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      const body = (await response.json()) as { message?: string; error?: string };

      if (!response.ok) {
        setError(body.error ?? 'Unable to send code right now.');
        if (response.status === 429) {
          const seconds = body.error?.match(/(\d+) seconds/)?.[1];
          setCooldown(seconds ? parseInt(seconds, 10) : 30);
        }
        return;
      }

      setMessage(body.message ?? GENERIC_SUCCESS_MESSAGE);
      setStep('otp');
      setCooldown(30);
    } catch {
      setError('Unable to send code right now.');
    } finally {
      setSending(false);
    }
  }

  async function verifyCode() {
    setVerifying(true);
    setError('');

    try {
      const response = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, token: code }),
      });

      const body = (await response.json()) as { redirectTo?: string; error?: string };

      if (!response.ok || !body.redirectTo) {
        setError(body.error ?? 'Unable to verify that code.');
        return;
      }

      // For PWA, always redirect to /dashboard regardless of server response
      const destination = appType === 'pwa' ? '/dashboard' : body.redirectTo;
      router.replace(destination);
    } catch {
      setError('Unable to verify that code.');
    } finally {
      setVerifying(false);
    }
  }

  // Styling note: this component is rendered by BOTH apps, so it deliberately
  // uses only stock Tailwind utilities — no design-system token classes and no
  // app-defined utilities. Anything app-specific here renders unstyled in the
  // other app. TODO(new product): restyle, but keep it self-contained.
  const primaryButton =
    'flex w-full items-center justify-center rounded-lg bg-neutral-900 px-4 py-3 font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60';

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="mx-auto max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-neutral-500">
            {BOILERPLATE_BRAND.shortName} Return Login
          </p>
          <h1 className="mt-3 text-3xl font-extrabold text-neutral-900">
            {step === 'email' ? 'Welcome back' : 'Enter the 6-digit code'}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            {step === 'email'
              ? 'Use the same email you used when you purchased your plan.'
              : message || GENERIC_SUCCESS_MESSAGE}
          </p>
        </div>

        {step === 'email' ? (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void requestOtp();
            }}
          >
            <label className="block text-sm font-medium text-neutral-900" htmlFor="login-email">
              Email address
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 text-neutral-900 outline-none transition focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10"
              placeholder="you@example.com"
            />

            <button type="submit" disabled={sending || cooldown > 0} className={primaryButton}>
              {sending ? 'Sending...' : cooldown > 0 ? `Wait (${cooldown}s)` : 'Send code'}
            </button>
          </form>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void verifyCode();
            }}
          >
            <OtpInput value={code} onChange={setCode} disabled={verifying} />

            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className={primaryButton}
            >
              {verifying ? 'Verifying...' : 'Verify code'}
            </button>

            <button
              type="button"
              onClick={() => {
                void requestOtp();
              }}
              disabled={cooldown > 0 || sending}
              className="w-full rounded-lg border border-neutral-300 px-4 py-3 text-sm font-medium text-neutral-900 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            </button>
          </form>
        )}

        {error ? <p className="mt-4 text-sm font-medium text-red-600">{error}</p> : null}
      </div>
    </div>
  );
}
