'use client';

import { Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@repo/i18n/navigation';
import {
  LOCALE_CURRENCY_MAP,
  resolveProductPrice,
  type Locale,
  type ProductId,
} from '@repo/shared/price-map';
import { formatPrice } from '@repo/shared/format-price';
import { useQuizStore } from '@/stores/quiz-store';
import { useFunnelStore } from '@/stores/funnel-store';
import { useQuizHydration } from '@/features/quiz/hooks/use-quiz-hydration';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { useScrollToTop } from '@/lib/hooks/use-scroll-to-top';
import { useSolidgateOtoResume } from '../lib/use-solidgate-oto-resume';
import { advanceOtoBeforeNavigation, resolveOtoNavigationTarget } from '../lib/advance-oto';
import { useOtoProgressRecovery } from '../lib/use-oto-progress-recovery';
import {
  chargeOtoSolidgate,
  otoLifecycleEventProperties,
  otoPurchaseEventProperties,
} from '../lib/charge-oto';
import { solidgateCatalogError } from '@/features/checkout/lib/catalog-seed';
import { useMainPaymentGrant } from '../lib/use-main-payment-grant';
import { useSavedCard } from '../lib/use-saved-card';
import type { OtoPageConfig } from '../config/oto-config';
import { LandingNav } from '@/app/[locale]/_components/landing/LandingNav';
import '@/app/[locale]/_components/landing/landing.css';

/**
 * ONE page component for OTO slots 1..7.
 *
 * Everything product-specific lives in `../config/oto-config.ts` and in the
 * `oto.*` message namespace. Everything below is payment plumbing that took a
 * dozen production incidents to get right — read the comments before editing.
 *
 * TODO(new product): restyle freely, but keep the ORDER of the branches in
 * `handleBuy` and keep `handleSkip` going through advanceOtoBeforeNavigation.
 */
export interface OtoTemplateProps {
  config: OtoPageConfig;
  /**
   * /preview review mode: no gating, no analytics, no charges. Buy and skip
   * both just walk to the next preview page.
   */
  preview?: boolean;
}

const CARD_BASE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  alignItems: 'center',
  gap: 14,
  padding: '18px',
  background: 'var(--paper)',
  border: '1px solid var(--hairline-strong)',
  cursor: 'pointer',
  transition: 'border-color 0.15s, background 0.15s',
  textAlign: 'left',
  width: '100%',
  fontFamily: 'inherit',
};

/**
 * `useMainPaymentGrant` reads `?sg_main` through `useSearchParams`, which needs
 * a Suspense boundary or Next.js opts the whole route out of static rendering
 * at build time. The page renders nothing before hydration anyway, so a null
 * fallback costs nothing.
 */
export function OtoTemplate(props: OtoTemplateProps) {
  return (
    <Suspense fallback={null}>
      <OtoTemplateInner {...props} />
    </Suspense>
  );
}

function OtoTemplateInner({ config, preview = false }: OtoTemplateProps) {
  const t = useTranslations(config.i18nNamespace);
  const tCommon = useTranslations('oto.common');
  const tButtons = useTranslations('common.buttons');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const hydrated = useQuizHydration();

  const sessionId = useQuizStore((s) => s.sessionId);
  const isComplete = useQuizStore((s) => s.isComplete);
  const authorizedViaPurchase = useQuizStore((s) => s.authorizedViaPurchase);
  const setStage = useFunnelStore((s) => s.setStage);
  const { track } = useAnalytics();

  const [selectedOptionId, setSelectedOptionId] = useState<string>(
    config.defaultOptionId ?? config.options[0]!.id,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Still-settling charge: calm status, not an error — the card may already be
  // charged, and the same order resumes on retry/refresh (never re-charged).
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);

  // ─── Main-payment settlement watch (slot 1 only) ──────────────────────────
  const mainGrant = useMainPaymentGrant(!preview && config.watchesMainPayment === true);
  // A validated exact-order recovery marker is enough to render OTO1 even when
  // the quiz store was lost across the issuer round-trip; the server-side proxy
  // separately requires its short-lived signed cookie.
  const activeSessionId = mainGrant.marker?.sessionId ?? sessionId;

  const gateSatisfied =
    config.gate === 'session'
      ? true
      : isComplete || authorizedViaPurchase || mainGrant.marker !== null;
  const eligible = preview || (hydrated && !!activeSessionId && gateSatisfied);

  // Replays a prior page's failed advance and follows a later canonical
  // checkpoint forward only. Must stay off while the main grant is unresolved.
  useOtoProgressRecovery(activeSessionId, !preview && eligible && !mainGrant.locked);
  useScrollToTop(eligible);

  const savedCard = useSavedCard({
    sessionId: activeSessionId,
    enabled: (config.requiresSavedCard ?? false) && eligible && !preview,
    paused: mainGrant.locked,
  });

  const selectedOption =
    config.options.find((option) => option.id === selectedOptionId) ?? config.options[0]!;
  const selectedProductId: ProductId = selectedOption.productId;

  useEffect(() => {
    if (!eligible) return;
    setStage('checkout');
    if (preview) return;
    track(config.events.viewed, {
      session_id: activeSessionId ?? undefined,
      product: selectedProductId,
    });
    // Fires once per page, not once per option change — the viewed event is a
    // page-view, and the config/product pair is stable for a given slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, preview, activeSessionId, setStage, track]);

  // ─── Prices ───────────────────────────────────────────────────────────────
  // Always resolved from PRICE_MAP; never a hardcoded amount or symbol.
  const priced = useMemo(
    () =>
      config.options.map((option) => {
        const resolved = resolveProductPrice(option.productId, locale);
        const quotedCents =
          config.introAmounts?.[LOCALE_CURRENCY_MAP[locale]] ?? resolved.amountCents;
        return {
          ...option,
          amountCents: quotedCents,
          price: formatPrice(quotedCents, resolved.currency, locale),
          recurringPrice: formatPrice(resolved.amountCents, resolved.currency, locale),
          compareAt:
            option.compareAtRatio !== undefined
              ? formatPrice(
                  Math.round(resolved.amountCents * option.compareAtRatio),
                  resolved.currency,
                  locale,
                )
              : null,
        };
      }),
    [config.options, config.introAmounts, locale],
  );
  const selectedPrice = priced.find((entry) => entry.id === selectedOption.id) ?? priced[0]!;
  const anchorPrice = useMemo(() => {
    if (!config.anchorProductId) return null;
    const resolved = resolveProductPrice(config.anchorProductId, locale);
    return formatPrice(resolved.amountCents, resolved.currency, locale);
  }, [config.anchorProductId, locale]);

  const benefits = useMemo(() => {
    try {
      const raw = t.raw('benefits');
      return Array.isArray(raw) ? (raw as string[]) : [];
    } catch {
      // A slot is allowed to ship without a bullet list.
      return [];
    }
  }, [t]);

  // ─── Back from a 3DS redirect (?sg_confirm) ───────────────────────────────
  // Finish the charge and carry on down the chain exactly as an inline success
  // would. The slug MUST be the currently selected option — the server binds
  // the order to it, and a mismatch is rejected as 'binding_mismatch'.
  useSolidgateOtoResume({
    slug: selectedProductId,
    sessionId: activeSessionId,
    onSuccess: (charged) => {
      track('checkout_completed', otoPurchaseEventProperties(charged, activeSessionId));
      track(
        config.events.purchased,
        otoLifecycleEventProperties(charged, activeSessionId, config.events.purchased),
      );
      mainGrant.release();
      router.push(resolveOtoNavigationTarget(charged, config.step));
    },
    onAccepted: (charged) => {
      mainGrant.release();
      router.push(resolveOtoNavigationTarget(charged, config.step));
    },
    onPending: () => setPendingMsg(tCommon('paymentPending')),
    onError: (code) => {
      if (code === 'payment_pending') {
        setPendingMsg(tCommon('paymentPending'));
      } else {
        setPendingMsg(null);
        setErrorMsg(t('paymentError'));
      }
    },
  });

  const handleBuy = async () => {
    if (preview) {
      router.push(config.previewNext);
      return;
    }
    if (!activeSessionId || submitting || mainGrant.locked) return;
    // An unseeded PSP catalog would POST an empty product id and come back as a
    // cryptic provider rejection. Name the fix in the console instead.
    const catalogError = solidgateCatalogError(selectedProductId, locale);
    if (catalogError) {
      console.error('[oto%d] %s', config.step, catalogError);
      setErrorMsg(t('paymentError'));
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    setPendingMsg(null);
    try {
      const outcome = await chargeOtoSolidgate({
        slug: selectedProductId,
        sessionId: activeSessionId,
        onPending: () => setPendingMsg(tCommon('paymentPending')),
      });
      // (a) 3DS step-up: the browser is leaving for the issuer's ACS page.
      if (outcome.redirecting) {
        mainGrant.release();
        return;
      }
      // (b) Provider accepted the bound charge; capture stays webhook-owned, so
      //     advance WITHOUT emitting purchase analytics.
      if (outcome.accepted) {
        mainGrant.release();
        router.push(resolveOtoNavigationTarget(outcome, config.step));
        return;
      }
      if (!outcome.ok) {
        // (c) An indeterminate handoff stays on this offer and keeps the same
        //     server-bound order available for retry. Never mint a new one.
        if (outcome.pending) {
          setSubmitting(false);
          return;
        }
        // (d)
        throw new Error(outcome.error ?? 'charge_failed');
      }
      // (e)
      track('checkout_completed', otoPurchaseEventProperties(outcome, activeSessionId));
      track(
        config.events.purchased,
        otoLifecycleEventProperties(outcome, activeSessionId, config.events.purchased),
      );
      mainGrant.release();
      router.push(resolveOtoNavigationTarget(outcome, config.step));
      // `submitting` is deliberately NOT reset on the success paths: the page
      // is unmounting and a re-enabled button invites a double charge.
    } catch (err) {
      console.error(`[oto${config.step}] charge failed:`, err);
      setPendingMsg(null);
      setErrorMsg(t('paymentError'));
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (preview) {
      router.push(config.previewNext);
      return;
    }
    if (mainGrant.locked) return;
    mainGrant.release();
    if (activeSessionId) {
      track(config.events.declined, {
        session_id: activeSessionId,
        product: selectedProductId,
      });
    }
    // Never call resolveOtoNavigationTarget directly on the decline path:
    // advanceOtoBeforeNavigation persists the durable checkpoint first and
    // navigates in a finally block, so a failed write still moves the buyer.
    await advanceOtoBeforeNavigation({
      sessionId: activeSessionId,
      currentStep: config.step,
      navigate: (target) => router.push(target),
    });
  };

  if (!eligible) return null;

  const cardMissing = config.requiresSavedCard === true && savedCard.state === 'missing';
  const buyDisabled = preview
    ? false
    : submitting ||
      !hydrated ||
      mainGrant.locked ||
      (config.requiresSavedCard === true && savedCard.state !== 'ready');
  const declineDisabled = preview ? false : submitting || mainGrant.locked;

  // The main-payment watch owns the page-level status/error slots while it is
  // unresolved; a charge attempt cannot be in flight at the same time.
  const statusText = mainGrant.state === 'pending' ? tCommon('paymentPending') : pendingMsg;
  const alertText = mainGrant.state === 'terminal' ? t('paymentError') : errorMsg;

  return (
    <div className="lmRoot otoType" style={{ background: 'var(--paper)', minHeight: '100vh' }}>
      <LandingNav minimal />

      <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 22px 72px' }}>
        <header style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            className="mono-up"
            style={{ fontSize: 10, letterSpacing: '0.28em', opacity: 0.55, marginBottom: 14 }}
          >
            {t('eyebrow')}
          </div>
          <h1
            className="serif"
            style={{
              fontSize: 'clamp(28px, 5vw, 38px)',
              lineHeight: 1.1,
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            {t('headline')}
          </h1>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.6,
              color: 'var(--ink)',
              opacity: 0.78,
              margin: '14px auto 0',
              maxWidth: 460,
            }}
          >
            {t('subheadline')}
          </p>
        </header>

        {benefits.length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '0 0 28px',
              display: 'grid',
              gap: 10,
              borderTop: '1px solid var(--hairline)',
              paddingTop: 20,
            }}
          >
            {benefits.map((benefit, index) => (
              <li
                key={index}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: 12,
                  fontSize: 15,
                  lineHeight: 1.55,
                  color: 'var(--ink)',
                }}
              >
                <span aria-hidden style={{ opacity: 0.55 }}>
                  ✓
                </span>
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Options: a single product renders as a price panel, several render
            as a radio list. The selected option drives BOTH the charge and the
            3DS resume above. */}
        {priced.length > 1 ? (
          <div
            role="radiogroup"
            aria-label={t('headline')}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {priced.map((option) => {
              const isActive = option.id === selectedOption.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => setSelectedOptionId(option.id)}
                  style={{
                    ...CARD_BASE,
                    borderColor: isActive ? 'var(--ink)' : 'var(--hairline-strong)',
                    borderWidth: isActive ? 2 : 1,
                    padding: isActive ? '17px' : '18px',
                    background: isActive ? 'var(--paper-soft, #fafaf7)' : 'var(--paper)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      border: '1px solid var(--ink)',
                      background: isActive ? 'var(--ink)' : 'transparent',
                    }}
                  />
                  <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 16, color: 'var(--ink)' }}>
                      {t(`items.${option.id}.title`)}
                    </span>
                    <span style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.65 }}>
                      {t(`items.${option.id}.description`)}
                    </span>
                  </span>
                  <span
                    className="serif"
                    style={{ fontSize: 17, color: 'var(--ink)', whiteSpace: 'nowrap' }}
                  >
                    {option.compareAt && (
                      <s style={{ opacity: 0.45, marginRight: 8, fontSize: 14 }}>
                        {option.compareAt}
                      </s>
                    )}
                    {option.price}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--hairline-strong)',
              padding: '22px 20px',
              textAlign: 'center',
              background: 'var(--paper)',
            }}
          >
            <div className="serif" style={{ fontSize: 34, color: 'var(--ink)' }}>
              {selectedPrice.compareAt && (
                <s style={{ opacity: 0.4, marginRight: 10, fontSize: 22 }}>
                  {selectedPrice.compareAt}
                </s>
              )}
              {selectedPrice.price}
            </div>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, opacity: 0.7 }}>
              {config.introAmounts
                ? t('priceNote', { recurring: selectedPrice.recurringPrice })
                : t('priceNote', { recurring: selectedPrice.price })}
            </div>
            {anchorPrice && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55 }}>
                {t('anchorNote', { anchor: anchorPrice })}
              </div>
            )}
          </div>
        )}

        {/* Saved-card gate (slot 1). Never blocks the decline path. */}
        {config.requiresSavedCard && !preview && (
          <p style={{ marginTop: 14, fontSize: 12, lineHeight: 1.5, opacity: 0.7 }}>
            {savedCard.state === 'ready' && savedCard.card
              ? t('savedCard', { brand: savedCard.card.brand, last4: savedCard.card.last4 })
              : savedCard.state === 'loading'
                ? t('savedCardLoading')
                : t('savedCardMissing')}
          </p>
        )}
        {cardMissing && !preview && (
          <button
            type="button"
            onClick={savedCard.retry}
            className="tap mono-up"
            style={{
              marginTop: 10,
              padding: '10px 16px',
              border: '1px solid var(--ink)',
              background: 'transparent',
              color: 'var(--ink)',
              fontSize: 10,
              letterSpacing: '0.22em',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {tButtons('tryAgain')}
          </button>
        )}

        {/* Two distinct message slots. A pending charge is NOT a decline —
            the card may already be charged, so it must never read as an error. */}
        {alertText && (
          <p
            role="alert"
            style={{ marginTop: 16, fontSize: 13, lineHeight: 1.55, color: '#b3261e' }}
          >
            {alertText}
          </p>
        )}
        {statusText && (
          <p
            role="status"
            aria-live="polite"
            style={{ marginTop: 16, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}
          >
            {statusText}
          </p>
        )}

        <button
          type="button"
          onClick={handleBuy}
          disabled={buyDisabled}
          className="tap mono-up"
          style={{
            marginTop: 24,
            width: '100%',
            padding: '20px 22px',
            background: buyDisabled ? 'var(--hairline-strong)' : 'var(--accent)',
            color: 'var(--accent-ink)',
            border: '1px solid var(--ink)',
            fontSize: 11,
            letterSpacing: '0.22em',
            fontFamily: 'inherit',
            cursor: buyDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? t('ctaProcessing') : t('cta')}
        </button>

        <p style={{ marginTop: 14, fontSize: 11, lineHeight: 1.55, opacity: 0.6 }}>
          {t('disclaimer', { price: selectedPrice.price })}
        </p>

        <button
          type="button"
          onClick={handleSkip}
          disabled={declineDisabled}
          style={{
            marginTop: 20,
            width: '100%',
            background: 'transparent',
            border: 'none',
            color: 'var(--ink)',
            opacity: declineDisabled ? 0.4 : 0.65,
            fontSize: 13,
            textDecoration: 'underline',
            fontFamily: 'inherit',
            cursor: declineDisabled ? 'not-allowed' : 'pointer',
            padding: '8px 0',
          }}
        >
          {t('ctaDecline')}
        </button>
      </main>
    </div>
  );
}
