'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { OtpInput } from '@repo/shared/auth/otp-input';
import { OTP_LENGTH, isCompleteOtp } from '@repo/shared/auth/otp-length';
import { BrandMark } from '../_components/BrandMark';

/**
 * Email → an OTP_LENGTH-digit code, the same flow the funnel's admin dashboard
 * uses. Both
 * sit on @repo/shared/auth, so there is one OTP implementation to keep correct
 * rather than three.
 */
export function CroLoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function requestOtp() {
    setSending(true);
    setError('');
    try {
      const response = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setError(body.error ?? 'Unable to send a code right now.');
        return;
      }
      // Advances even for an address that is not allowlisted — the endpoint
      // returns the same success either way, so the UI must not reveal the
      // difference by refusing to move on.
      setNotice(body.message ?? '');
      setStep('otp');
    } catch {
      setError('Unable to send a code right now.');
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token: code }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || !body.redirectTo) {
        setError(body.error ?? 'That code did not work.');
        return;
      }
      router.replace(body.redirectTo);
    } catch {
      setError('That code did not work.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="card w-full max-w-sm space-y-6 p-6">
      <header>
        <BrandMark size="lg" />
        <p className="mt-3 text-sm text-ink-soft">
          {step === 'email'
            ? `Sign in with your work email — we will send you an ${OTP_LENGTH}-digit code.`
            : `Enter the ${OTP_LENGTH}-digit code we just sent.`}
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
          <label className="block text-sm font-medium text-ink" htmlFor="cro-email">
            Email
          </label>
          <input
            id="cro-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-hairline-strong bg-paper px-4 py-2 text-sm text-ink outline-none"
            placeholder="you@example.com"
            required
          />
          <button
            type="submit"
            disabled={sending || !email}
            className="w-full rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
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
            disabled={verifying || !isCompleteOtp(code)}
            className="w-full rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {verifying ? 'Verifying…' : 'Verify code'}
          </button>
        </form>
      )}

      {notice ? <p className="text-sm text-ink-soft">{notice}</p> : null}
      {error ? <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>{error}</p> : null}
    </div>
  );
}
