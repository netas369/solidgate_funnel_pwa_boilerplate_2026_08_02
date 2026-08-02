'use client';

import { useState, useRef, useEffect, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SpecialOfferEmailGateProps {
  /** Called once with the freshly minted session id after a valid submission. */
  onSubmit: (sessionId: string) => void;
  /**
   * Session `source` attribution, also used by /api/session/persist to decide
   * whether to add the contact to the marketing list.
   */
  source?: 'special-offer' | 'special-offer-free';
}

/**
 * Hard-block email gate for /special-offer and /special-offer-free.
 *
 * Deliberately NOT dismissible: no Escape handler, no backdrop click, no close
 * button. The only exit is a resolved submission. Direct entrants from an
 * abandonment email have no quiz session, so this is where their session is
 * created — losing it means the whole downstream OTO chain has nothing to bind
 * a purchase to.
 *
 * The parent must render the page chrome behind this gate with `inert`, so
 * focus and pointer events stay inside the modal.
 *
 * Does NOT read the email from the URL: every visit creates a fresh session
 * row rather than trusting an address supplied by whoever shared the link.
 */
export function SpecialOfferEmailGate({
  onSubmit,
  source = 'special-offer',
}: SpecialOfferEmailGateProps) {
  const t = useTranslations('offer.specialEmailGate');
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // True when /api/session/persist replied 409 already_subscribed for this
  // email. Locks the form into a "go to login" terminal state; editing the
  // address clears it so a different one can be tried.
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pwaUrl = (process.env.NEXT_PUBLIC_PWA_URL || '').replace(/\/$/, '');
  const loginHref = pwaUrl ? `${pwaUrl}/login` : '/login';

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // INTENTIONALLY ABSENT: key handler, backdrop onClick, close button.

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError(t('invalidEmail'));
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      // One fresh session id per visit (matches the quiz page's convention).
      const sessionId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const res = await fetch('/api/session/persist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          email: trimmed,
          locale,
          source,
          answers: {},
          currentStepId: null,
        }),
      });

      // Duplicate-account guard: this email already owns an active
      // entitlement. Surface a login link instead of letting them buy twice.
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === 'already_subscribed') {
          setAlreadySubscribed(true);
          setSubmitting(false);
          return;
        }
      }

      if (!res.ok) throw new Error(`persist failed: ${res.status}`);

      onSubmit(sessionId);
    } catch (err) {
      console.error('[SpecialOfferEmailGate] submit failed:', err);
      setError(t('tryAgain'));
      setSubmitting(false);
    }
  }

  // The panel is wrapped in `lmRoot` so the .serif / .mono-up / .body-sans /
  // .tap selectors from landing.css resolve.
  const fieldStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--paper)',
    color: 'var(--ink)',
    border: '1px solid var(--hairline-strong)',
    borderRadius: 0,
    padding: '14px',
    fontFamily: 'inherit',
    fontSize: 16,
    outline: 'none',
  };
  const submitStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--accent)',
    color: 'var(--accent-ink)',
    border: '1px solid var(--ink)',
    padding: '20px 22px',
    fontSize: 11,
    letterSpacing: '0.22em',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  };

  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center px-4"
      style={{ background: 'rgba(10, 10, 10, 0.62)', backdropFilter: 'blur(4px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="special-gate-title"
    >
      <motion.div
        className="lmRoot relative w-full max-w-md max-h-[90vh] overflow-y-auto"
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--hairline-strong)',
          padding: '40px 32px',
        }}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.2 }}
      >
        <div className="mono-up" style={{ opacity: 0.55, marginBottom: 14 }}>
          {BOILERPLATE_BRAND.shortName}
        </div>
        <h2
          id="special-gate-title"
          className="serif"
          style={{
            fontSize: 'clamp(28px, 5vw, 40px)',
            lineHeight: 1.08,
            color: 'var(--ink)',
            margin: 0,
          }}
        >
          {source === 'special-offer-free' ? t('titleFree') : t('title')}
        </h2>
        <p className="serif-it" style={{ fontSize: 16, opacity: 0.7, marginTop: 14, lineHeight: 1.5 }}>
          {t('subtitle')}
        </p>
        <form onSubmit={handleSubmit} noValidate style={{ marginTop: 28 }}>
          <input
            ref={inputRef}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError('');
              if (alreadySubscribed) setAlreadySubscribed(false);
            }}
            placeholder={t('emailPlaceholder')}
            aria-label={t('emailPlaceholder')}
            style={fieldStyle}
          />
          {error && !alreadySubscribed && (
            <p
              className="body-sans"
              role="alert"
              style={{ marginTop: 10, fontSize: 13, color: '#b3261e' }}
            >
              {error}
            </p>
          )}
          {alreadySubscribed && (
            <div
              role="alert"
              className="body-sans"
              style={{
                marginTop: 14,
                padding: '14px',
                border: '1px solid var(--ink)',
                background: 'var(--paper-soft, #fafaf7)',
                color: 'var(--ink)',
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              <div
                className="mono-up"
                style={{ fontSize: 9, letterSpacing: '0.22em', opacity: 0.6, marginBottom: 8 }}
              >
                {t('alreadySubscribed.kicker')}
              </div>
              <div style={{ marginBottom: 12 }}>{t('alreadySubscribed.body')}</div>
              <a
                href={loginHref}
                className="tap mono-up"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 18px',
                  border: '1px solid var(--ink)',
                  background: 'var(--ink)',
                  color: 'var(--paper)',
                  textDecoration: 'none',
                  fontSize: 10,
                  letterSpacing: '0.22em',
                }}
              >
                {t('alreadySubscribed.loginCta')}
              </a>
            </div>
          )}
          <button
            type="submit"
            disabled={!email || submitting || alreadySubscribed}
            className="tap mono-up"
            style={{
              ...submitStyle,
              marginTop: 22,
              opacity: !email || submitting || alreadySubscribed ? 0.4 : 1,
              cursor: !email || submitting || alreadySubscribed ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? t('submitting') : t('submitButton')}
          </button>
        </form>
      </motion.div>
    </motion.div>
  );
}
