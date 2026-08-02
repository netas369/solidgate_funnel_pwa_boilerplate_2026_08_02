'use client';

import { useCallback, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { EmailCaptureStep } from '@/features/quiz/config/quiz-schema';
import type { EmailConsentData } from '@/features/quiz/config/consent';
import { EMAIL_CONSENT_VERSION } from '@/features/quiz/config/consent';
import { QuizNav } from './quiz-nav';

interface EmailCaptureStepProps {
  step: EmailCaptureStep;
  t: ReturnType<typeof useTranslations>;
  tRaw?: (key: string) => string;
  resolvedCopy?: (template: string) => string;
  onSubmit: (data: EmailConsentData) => void | Promise<void>;
  onBack?: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FONT_SERIF = "var(--font-display), Georgia, serif";
const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const ACCENT = '#7f4cf2';
const ERROR = '#ff8a8a';

export function EmailCaptureStep({ step, t, tRaw, resolvedCopy, onSubmit, onBack }: EmailCaptureStepProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [consentChecked, setConsentChecked] = useState(true);

  const stepKey = step.stepId;
  const copy = (key: string) => (resolvedCopy && tRaw ? resolvedCopy(tRaw(key)) : t(key));

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (submitting) return;
      if (!EMAIL_RE.test(email.trim())) {
        setError(t('ui.validEmail'));
        return;
      }
      if (!consentChecked) return;
      setError('');
      setSubmitting(true);
      try {
        await onSubmit({
          email: email.trim(),
          consentGivenAt: new Date().toISOString(),
          consentVersion: EMAIL_CONSENT_VERSION,
          // Business decision (2026-07-17): marketing consent is always
          // granted — the opt-out checkbox was removed from the funnel.
          marketingConsent: true,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [email, onSubmit, submitting, consentChecked, t],
  );

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        // Viewport contract: the step owns exactly one screen and never
        // scrolls the document. Always dvh — never vh.
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: '#ffffff',
      }}
    >
      {/* Full-bleed backdrop — pure CSS, no asset dependency. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #1d092c 0%, #2f0a5e 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(62,0,128,0.3) 0%, rgba(19,0,45,0.3) 100%)' }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 480, margin: '0 auto', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <QuizNav onBack={onBack ?? (() => {})} backLabel={t('ui.back')} />

        <form
          id="lm-email-form"
          onSubmit={handleSubmit}
          noValidate
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            // Emergency fallback only (landscape phones, on-screen keyboard,
            // absurdly long translations): everything below is dvh-scaled to
            // fit, but the column scrolls rather than clipping the CTA.
            overflowY: 'auto',
            overflowX: 'hidden',
            // Two-point ramps: exactly the floor at 568dvh, exactly the
            // design value at 844dvh (see clamp math in each comment).
            // top:    F=8  V=24 -> A=5.797  B=24.93
            // bottom: F=8  V=40 -> A=11.5942 B=57.855
            padding:
              'clamp(8px, calc(5.797dvh - 24.93px), 24px) 22px clamp(8px, calc(11.5942dvh - 57.855px), 40px)',
          }}
        >
          <h1
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              // F=16 V=28 -> A=4.35 B=8.71 (the dvh term reaches the 28px cap
              // at 844dvh; the original 5.8vw term still wins at the 390px
              // design width, giving the unchanged 22.62px).
              fontSize: 'clamp(16px, min(5.8vw, calc(4.35dvh - 8.71px)), 28px)',
              lineHeight: 1.12,
              color: '#ffffff',
            }}
          >
            {copy(`steps.${stepKey}.title`)}
          </h1>
          {/* Wider than the old 28px: the subtext paragraph that used to sit
              between the title and this field is gone, so this gap now carries
              the whole heading-to-form separation on its own.
              marginTop F=10 V=40 -> A=10.87 B=51.74 */}
          <label htmlFor="lm-email" style={{ display: 'block', marginTop: 'clamp(10px, calc(10.87dvh - 51.74px), 40px)' }}>
            {/* font F=12 V=13 -> A=0.36 B=-9.96 | marginBottom F=4 V=10 -> A=2.174 B=8.35 */}
            <span style={{ display: 'block', fontSize: 'clamp(12px, calc(0.36dvh + 9.96px), 13px)', color: '#cec1d6', marginBottom: 'clamp(4px, calc(2.174dvh - 8.35px), 10px)' }}>
              {t('ui.emailLabel')}
            </span>
            <input
              id="lm-email"
              type="email"
              autoComplete="email"
              value={email}
              placeholder={t('ui.emailPlaceholder')}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'lm-email-error' : undefined}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
              }}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.06)',
                color: '#ffffff',
                border: `1px solid ${error ? ERROR : 'rgba(255,255,255,0.22)'}`,
                borderRadius: 14,
                // F=10 V=15 -> A=1.81 B=0.28 (the 44px minHeight still governs
                // the tap target on short screens).
                padding: 'clamp(10px, calc(1.81dvh - 0.28px), 15px) 16px',
                // NEVER below 16px: iOS Safari auto-zooms the page on focus.
                fontSize: 16,
                minHeight: 44,
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            {error && (
              <span
                id="lm-email-error"
                role="alert"
                style={{ display: 'block', fontSize: 'clamp(12px, calc(0.72dvh + 7.89px), 14px)', fontWeight: 500, marginTop: 'clamp(3px, calc(1.81dvh - 7.28px), 8px)', color: ERROR }}
              >
                {error}
              </span>
            )}
          </label>

          {/* marginTop F=8 V=30 -> A=7.971 B=37.27 | gap F=5 V=14 -> A=3.26 B=13.51 */}
          <div style={{ marginTop: 'clamp(8px, calc(7.971dvh - 37.27px), 30px)', display: 'flex', flexDirection: 'column', gap: 'clamp(5px, calc(3.26dvh - 13.51px), 14px)' }}>
            <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                aria-label={t('ui.consentProcessingAria')}
                style={{ marginTop: 3, width: 'clamp(16px, calc(0.72dvh + 11.89px), 18px)', height: 'clamp(16px, calc(0.72dvh + 11.89px), 18px)', accentColor: ACCENT, flexShrink: 0 }}
              />
              <span style={{ fontSize: 'clamp(12px, calc(0.36dvh + 9.96px), 13px)', lineHeight: 1.55, color: 'rgba(255,255,255,0.78)' }}>
                {t.rich('ui.consentProcessing', {
                  link: (chunks) => (
                    <a
                      href="/privacy"
                      // Opens in a new tab on purpose: the visitor is mid-quiz
                      // with an unsubmitted form, and navigating away to read
                      // the policy would drop the email they just typed.
                      //
                      // A plain <a>, not next-intl's <Link>: it must survive
                      // rendering outside an IntlProvider (the consent tests do
                      // exactly that), and the routing proxy already redirects
                      // an unprefixed /privacy to the visitor's locale.
                      target="_blank"
                      rel="noopener noreferrer"
                      // Deliberately indistinguishable from the sentence around
                      // it — still a real link and still keyboard-reachable,
                      // just not styled as a call to action.
                      style={{ color: 'inherit', fontWeight: 'inherit', textDecoration: 'none' }}
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </span>
            </label>
          </div>

          <p
            style={{
              // F=6 V=18 -> A=4.348 B=18.70
              margin: 'clamp(6px, calc(4.348dvh - 18.70px), 18px) 0 0',
              fontSize: 12,
              letterSpacing: '0.04em',
              color: '#8f80a6',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span aria-hidden="true">🔒</span>
            {t('ui.dataSecure')}
          </p>

          {/* Absorbs the remaining space and collapses first on short screens. */}
          <div style={{ flex: '1 1 auto', minHeight: 0 }} />

          <button
            type="submit"
            disabled={!email || !consentChecked || submitting}
            style={{
              width: '100%',
              flex: '0 0 auto',
              // F=6 V=28 -> A=7.97 B=39.27
              marginTop: 'clamp(6px, calc(7.97dvh - 39.27px), 28px)',
              background: ACCENT,
              color: '#ffffff',
              border: 'none',
              borderRadius: 100,
              // padding F=10 V=17 -> A=2.54 B=4.44 | font F=14 V=16 -> A=0.72 B=-9.92
              padding: 'clamp(10px, calc(2.54dvh - 4.44px), 17px) 22px',
              // 44px tap-target floor is never crossed.
              minHeight: 44,
              fontSize: 'clamp(14px, calc(0.72dvh + 9.92px), 16px)',
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: !email || !consentChecked || submitting ? 'not-allowed' : 'pointer',
              opacity: !email || !consentChecked || submitting ? 0.45 : 1,
              transition: 'opacity 0.2s ease',
              boxShadow: '0 10px 26px rgba(127,76,242,0.35)',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {submitting ? t('ui.submitting') : t(step.buttonLabel)}
          </button>
        </form>
      </div>
    </div>
  );
}
