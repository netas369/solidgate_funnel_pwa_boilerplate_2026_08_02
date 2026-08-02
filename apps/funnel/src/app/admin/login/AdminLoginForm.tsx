'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { OtpInput } from '@repo/shared/auth/otp-input';

export function AdminLoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function requestOtp() {
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/admin/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(body.error ?? 'Unable to send code right now.');
        return;
      }
      setStep('otp');
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
      const response = await fetch('/api/admin/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token: code }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || !body.redirectTo) {
        setError(body.error ?? 'Unable to verify that code.');
        return;
      }
      router.replace(body.redirectTo);
    } catch {
      setError('Unable to verify that code.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">Admin sign-in</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {step === 'email'
            ? 'Enter your admin email to receive a 6-digit code.'
            : 'Enter the 6-digit code we just sent.'}
        </p>
      </header>

      {step === 'email' ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void requestOtp();
          }}
        >
          <label className="block text-sm font-medium text-neutral-700" htmlFor="admin-email">
            Email
          </label>
          <input
            id="admin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
            placeholder="you@example.com"
            required
          />
          <button
            type="submit"
            disabled={sending || !email}
            className="w-full rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void verifyCode();
          }}
        >
          <OtpInput value={code} onChange={setCode} disabled={verifying} />
          <button
            type="submit"
            disabled={verifying || code.length !== 6}
            className="w-full rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'Verify code'}
          </button>
        </form>
      )}

      {error ? (
        <p className="text-sm font-medium text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
