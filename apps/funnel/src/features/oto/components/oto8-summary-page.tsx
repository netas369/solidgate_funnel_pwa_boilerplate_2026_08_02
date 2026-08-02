'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@repo/i18n/navigation';
import type { Locale } from '@repo/i18n/routing';
import { formatPrice } from '@repo/shared/format-price';
import type { Currency } from '@repo/shared/price-map';
import type { ProductKey } from '@repo/shared/oto-product-label';
import { useQuizStore } from '@/stores/quiz-store';
import { useQuizHydration } from '@/features/quiz/hooks/use-quiz-hydration';
import { useOtoProgressRecovery } from '../lib/use-oto-progress-recovery';
import {
  reconcileAcceptedOtoRecoverySweep,
  useAcceptedOtoRecovery,
} from '../lib/use-accepted-oto-recovery';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { LandingNav } from '@/app/[locale]/_components/landing/LandingNav';
import '@/app/[locale]/_components/landing/landing.css';

interface SummaryItem {
  productKey: ProductKey;
  amountCents: number;
  currency: string;
}

// Recurring products get a small grey subline explaining the rebill. These are
// the two subscription-shaped keys in the ProductKey union; a one-off download
// must never carry a renewal note.
const SUBSCRIPTION_KEYS = new Set<ProductKey>(['subscription', 'addon']);

// Sample rows shown only in /preview, so the page can be designed without a
// real session or purchase history.
const PREVIEW_ITEMS: SummaryItem[] = [
  { productKey: 'subscription', amountCents: 500, currency: 'eur' },
  { productKey: 'addon', amountCents: 100, currency: 'eur' },
  { productKey: 'lifetime', amountCents: 9900, currency: 'eur' },
  { productKey: 'pdf4', amountCents: 1900, currency: 'eur' },
];

const sectionMax: CSSProperties = { maxWidth: 540, margin: '0 auto', padding: '0 22px' };
// Onboarding shows both platform columns side by side, so it gets a wider frame.
const onboardingMax: CSSProperties = { maxWidth: 720, margin: '0 auto', padding: '0 22px' };

function AppleIcon({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 384 512"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function AndroidIcon({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 576 512"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M420.55 301.93a24 24 0 1 1 24-24 24 24 0 0 1-24 24m-265.1 0a24 24 0 1 1 24-24 24 24 0 0 1-24 24m273.7-144.48 47.94-83a10 10 0 1 0-17.27-10h0l-48.54 84.07a301.25 301.25 0 0 0-246.56 0L116.18 64.45a10 10 0 1 0-17.27 10h0l47.94 83C64.53 202.22 8.24 285.55 0 384h576c-8.24-98.45-64.54-181.78-146.85-226.55" />
    </svg>
  );
}

export function Oto8SummaryPage({ preview = false }: { preview?: boolean } = {}) {
  const locale = useLocale() as Locale;
  const t = useTranslations('oto.oto8Summary');
  const tCommon = useTranslations('oto.common');
  const router = useRouter();
  const hydrated = useQuizHydration();
  const sessionId = useQuizStore((s) => s.sessionId);
  const { track } = useAnalytics();

  const [items, setItems] = useState<SummaryItem[] | null>(preview ? PREVIEW_ITEMS : null);
  const [redirecting, setRedirecting] = useState(false);
  const [exitPendingMsg, setExitPendingMsg] = useState<string | null>(null);

  // Page-view event — fires once after store hydration.
  const viewReady = hydrated && !!sessionId;
  useOtoProgressRecovery(sessionId, !preview && viewReady);
  useAcceptedOtoRecovery(preview ? null : sessionId);
  useEffect(() => {
    if (preview || !viewReady) return;
    track('oto8_viewed', { session_id: sessionId ?? undefined, product: 'oto8_summary' });
  }, [preview, viewReady, sessionId, track]);

  // Load the real purchase history for this session.
  useEffect(() => {
    if (preview || !viewReady || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/orders/session-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId }),
        });
        const data = (await res.json().catch(() => ({}))) as { orders?: SummaryItem[] };
        if (!cancelled) setItems(res.ok && Array.isArray(data.orders) ? data.orders : []);
      } catch (err) {
        console.error('[oto8-summary] orders fetch failed:', err);
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preview, viewReady, sessionId]);

  // Items to render: fetched results once available; an empty list when the
  // store is hydrated but there is no session (e.g. direct navigation); else
  // null = still loading.
  const resolvedItems: SummaryItem[] | null =
    items !== null ? items : hydrated && !sessionId ? [] : null;

  const handleOpenApp = async () => {
    if (preview) {
      router.push('/preview');
      return;
    }
    if (redirecting) return;
    setRedirecting(true);
    setExitPendingMsg(null);

    if (sessionId) {
      try {
        // Once the buyer leaves the funnel there is no page left to surface a
        // late saved-card 3DS challenge. Sweep every accepted order before the
        // handoff and refuse to leave while any exact order is still ambiguous.
        const recovery = await reconcileAcceptedOtoRecoverySweep({ sessionId });
        if (recovery.redirectUrl) {
          window.location.assign(recovery.redirectUrl);
          return;
        }
        if (!recovery.queueEmpty) {
          setExitPendingMsg(tCommon('paymentPending'));
          setRedirecting(false);
          return;
        }
      } catch {
        setExitPendingMsg(tCommon('paymentPending'));
        setRedirecting(false);
        return;
      }
      track('oto8_open_app', { session_id: sessionId });
    }
    // The funnel /dashboard route relays a one-time magic-link token to the PWA
    // so the member lands already signed in.
    router.push('/dashboard');
  };

  const renderInstallColumn = (key: 'ios' | 'android', icon: ReactNode) => {
    const steps = t.raw(`platform.${key}.steps`) as string[];
    return (
      <div
        style={{
          border: '1px solid var(--hairline-strong)',
          padding: '24px 22px',
          background: 'var(--paper)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{ color: 'var(--ink)', display: 'inline-flex' }}>{icon}</span>
          <span
            className="mono-up"
            style={{ fontSize: 10, letterSpacing: '0.24em', opacity: 0.6, color: 'var(--ink)' }}
          >
            {t(`platform.${key}.heading`)}
          </span>
        </div>
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
          {steps.map((step, i) => (
            <li
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 12,
                alignItems: 'start',
              }}
            >
              <span
                className="serif"
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid var(--ink)',
                  borderRadius: '50%',
                  fontSize: 13,
                  color: 'var(--ink)',
                }}
              >
                {i + 1}
              </span>
              <span
                style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--ink)', opacity: 0.9, paddingTop: 2 }}
              >
                {step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  };

  return (
    <div className="lmRoot otoType" style={{ background: 'var(--paper)', minHeight: '100vh' }}>
      <LandingNav minimal />

      {/* Header */}
      <header style={{ ...sectionMax, paddingTop: 56, textAlign: 'center' }}>
        <div
          aria-hidden
          style={{
            width: 34,
            height: 34,
            margin: '0 auto 18px',
            border: '1px solid var(--ink)',
            borderRadius: '50%',
          }}
        />
        <div className="mono-up" style={{ fontSize: 10, letterSpacing: '0.32em', opacity: 0.55 }}>
          {t('letterEyebrow')}
        </div>
        <h1
          className="serif"
          style={{
            fontSize: 'clamp(30px, 6vw, 42px)',
            lineHeight: 1.12,
            color: 'var(--ink)',
            margin: '16px 0 12px',
            fontWeight: 500,
          }}
        >
          {t('title')}
        </h1>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--ink)',
            opacity: 0.78,
            margin: '0 auto',
            maxWidth: 460,
          }}
        >
          {t('subtitle')}
        </p>
        <div
          aria-hidden
          style={{ width: 56, height: 1, background: 'var(--ink)', opacity: 0.4, margin: '26px auto 0' }}
        />
      </header>

      {/* Purchases */}
      <section style={{ ...sectionMax, paddingTop: 44 }}>
        <div
          className="mono-up"
          style={{ fontSize: 10, letterSpacing: '0.28em', opacity: 0.55, marginBottom: 16 }}
        >
          {t('purchasesHeading')}
        </div>

        {resolvedItems === null ? (
          <p style={{ fontSize: 14, color: 'var(--ink)', opacity: 0.5, margin: 0 }}>
            {t('loading')}
          </p>
        ) : resolvedItems.length === 0 ? (
          <p style={{ fontSize: 15, color: 'var(--ink)', opacity: 0.7, margin: 0 }}>
            {t('emptyPurchases')}
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              borderTop: '1px solid var(--ink)',
            }}
          >
            {resolvedItems.map((item) => (
              <li
                key={item.productKey}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 16,
                  padding: '16px 0',
                  borderBottom: '1px solid var(--hairline)',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    fontSize: 16,
                    color: 'var(--ink)',
                  }}
                >
                  <span aria-hidden style={{ color: 'var(--ink)', opacity: 0.55, paddingTop: 1 }}>
                    ✓
                  </span>
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                    <span>{t(`items.${item.productKey}`)}</span>
                    {SUBSCRIPTION_KEYS.has(item.productKey) && (
                      <span style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--ink)', opacity: 0.5 }}>
                        {t('recurringNote')}
                      </span>
                    )}
                  </span>
                </span>
                <span
                  className="serif"
                  style={{ fontSize: 16, color: 'var(--ink)', whiteSpace: 'nowrap' }}
                >
                  {formatPrice(item.amountCents, item.currency as Currency, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Onboarding — add to home screen (iOS + Android, side by side) */}
      <section style={{ ...onboardingMax, paddingTop: 52 }}>
        <div style={{ textAlign: 'center', maxWidth: 460, margin: '0 auto 28px' }}>
          <h2
            className="serif"
            style={{
              fontSize: 'clamp(22px, 4.4vw, 28px)',
              lineHeight: 1.2,
              color: 'var(--ink)',
              margin: '0 0 8px',
              fontWeight: 500,
            }}
          >
            {t('onboardingHeading')}
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--ink)', opacity: 0.78, margin: 0 }}>
            {t('onboardingSubtitle')}
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 16,
          }}
        >
          {renderInstallColumn('ios', <AppleIcon />)}
          {renderInstallColumn('android', <AndroidIcon />)}
        </div>
      </section>

      {/* CTA */}
      <section style={{ ...sectionMax, paddingTop: 48, paddingBottom: 72, textAlign: 'center' }}>
        <button
          type="button"
          onClick={handleOpenApp}
          disabled={redirecting || (!preview && !hydrated)}
          style={{
            display: 'block',
            width: '100%',
            padding: '18px 18px',
            background:
              redirecting || (!preview && !hydrated) ? 'var(--hairline-strong)' : 'var(--ink)',
            color: 'var(--paper)',
            border: 'none',
            fontSize: 13,
            letterSpacing: '0.28em',
            fontFamily: 'inherit',
            fontWeight: 700,
            cursor: redirecting || (!preview && !hydrated) ? 'not-allowed' : 'pointer',
          }}
          className="mono-up"
        >
          {redirecting ? t('opening') : t('cta')}
        </button>
        <p style={{ marginTop: 16, fontSize: 12, lineHeight: 1.55, color: 'var(--ink)', opacity: 0.6 }}>
          {t('ctaHint')}
        </p>
        {exitPendingMsg && (
          <p
            role="status"
            aria-live="polite"
            style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}
          >
            {exitPendingMsg}
          </p>
        )}
      </section>
    </div>
  );
}
