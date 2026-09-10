'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@repo/shared/price-map';
import {
  SolidgateCheckout,
  CHECKOUT_ERROR_CODES,
  type SolidgateCheckoutSuccessContext,
} from '@/components/checkout/solidgate-checkout';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { attributionEventProperties } from '@/features/analytics/lib/attribution';
import { checkoutProductContext } from '@/features/analytics/lib/checkout-context';
import { solidgateCatalogError } from '@/features/checkout/lib/catalog-seed';
import { OFFER_PRICING_TIERS } from '../config/offer-data';
import { computeTierPrices } from './offer-sections';
import '@/app/[locale]/_components/landing/landing.css';

export interface OfferCheckoutModalProps {
  open: boolean;
  tier: (typeof OFFER_PRICING_TIERS)[number] | null;
  sessionId: string | null;
  onClose: () => void;
  /**
   * Forwards the checkout's success ctx to the parent page. Accepts `void` or
   * `Promise<void>` return so callers can perform async work before navigating.
   */
  onSuccess: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
  onAccepted?: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
}

/**
 * Full-screen modal wrapper around the hosted Solidgate checkout.
 *
 * The no-auto-mount guarantee lives here: `intent={true}` means the order is
 * only opened once this modal is actually on screen with a selected tier, so
 * merely visiting the offer page never creates a payment intent.
 *
 * Modal conventions (no Radix/shadcn in this repo):
 *   - motion/react AnimatePresence + motion.div
 *   - Escape closes, backdrop closes, clicks inside the panel do not
 *   - BOTH are blocked while a payment is in flight
 *   - Body scroll lock while open
 *   - role="dialog" aria-modal="true"
 */
export function OfferCheckoutModal({
  open,
  tier,
  sessionId,
  onClose,
  onSuccess,
  onAccepted,
}: OfferCheckoutModalProps) {
  const t = useTranslations('offer');
  const locale = useLocale() as Locale;
  const { track } = useAnalytics();
  const [paymentInFlight, setPaymentInFlight] = useState(false);
  const requestClose = useCallback(() => {
    if (!paymentInFlight) onClose();
  }, [onClose, paymentInFlight]);

  // Fire InitiateCheckout when modal opens with a valid tier (once per tier)
  const firedForTier = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !tier || firedForTier.current === tier.id) return;
    firedForTier.current = tier.id;
    track('checkout_opened', {
      session_id: sessionId ?? undefined,
      ...(checkoutProductContext(tier.productId, locale) ?? { product: tier.productId }),
      ...attributionEventProperties(),
    });
  }, [open, tier, sessionId, locale, track]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') requestClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, requestClose]);

  // Body scroll lock while open
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const showModal = open && !!tier;

  return (
    <AnimatePresence>
      {showModal && tier && (
        <motion.div
          className="lmRoot"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            background: 'var(--paper)',
            padding: '0',
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="offer-checkout-modal-title"
          onClick={requestClose}
        >
          <motion.div
            style={{
              position: 'relative',
              width: '100vw',
              height: '100vh',
              maxWidth: '100vw',
              maxHeight: '100vh',
              overflowY: 'auto',
              background: 'var(--paper)',
              border: 'none',
              padding: 'clamp(48px, 8vw, 72px) clamp(20px, 6vw, 64px) clamp(40px, 8vw, 64px)',
              boxShadow: 'none',
            }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button  -  square hairline, matches landing language */}
            <button
              type="button"
              onClick={requestClose}
              disabled={paymentInFlight}
              aria-label={t('checkoutModal.closeLabel')}
              style={{
                position: 'absolute',
                top: 14,
                right: 14,
                width: 32,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: '1px solid var(--hairline-strong)',
                color: 'var(--ink)',
                cursor: paymentInFlight ? 'not-allowed' : 'pointer',
                opacity: paymentInFlight ? 0.35 : 1,
                fontSize: 18,
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
            >
              ✕
            </button>

            <div style={{ width: '100%', maxWidth: 560, margin: '0 auto' }}>
            {/* Eyebrow + neutral placeholder mark */}
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <div
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  margin: '0 auto 12px',
                  border: '1px solid var(--ink)',
                  borderRadius: '50%',
                }}
              />
              <div
                className="mono-up"
                style={{ fontSize: 10, letterSpacing: '0.32em', opacity: 0.55 }}
              >
                {t('checkoutModal.secureCheckout')}
              </div>
            </div>

            <h2
              id="offer-checkout-modal-title"
              className="serif"
              style={{
                fontSize: 'clamp(24px, 4vw, 30px)',
                lineHeight: 1.15,
                color: 'var(--ink)',
                margin: '0 0 18px',
                textAlign: 'center',
                fontWeight: 500,
              }}
            >
              {t('checkoutModal.title')}
            </h2>

            <div
              aria-hidden
              style={{
                width: 56,
                height: 1,
                background: 'var(--ink)',
                opacity: 0.4,
                margin: '0 auto 24px',
              }}
            />

            <CheckoutBody
              tier={tier}
              locale={locale}
              t={t}
              sessionId={sessionId}
              onSuccess={onSuccess}
              onAccepted={onAccepted}
              onProcessingChange={setPaymentInFlight}
            />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface CheckoutBodyProps {
  tier: (typeof OFFER_PRICING_TIERS)[number];
  locale: Locale;
  t: ReturnType<typeof useTranslations>;
  sessionId: string | null;
  onSuccess: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
  onAccepted?: (ctx: SolidgateCheckoutSuccessContext) => void | Promise<void>;
  onProcessingChange: (processing: boolean) => void;
}

function CheckoutBody({
  tier,
  locale,
  t,
  sessionId,
  onSuccess,
  onAccepted,
  onProcessingChange,
}: CheckoutBodyProps) {
  // Fail loudly on an unseeded PSP catalog rather than POSTing an empty
  // product_id and letting Solidgate reject it with something cryptic.
  const catalogError = solidgateCatalogError(tier.productId, locale);
  const tierPrices = computeTierPrices(tier.productId, tier.discountPct, locale);
  const planName = t(tier.name);
  const priceCaption = t('checkoutModal.priceCaption', {
    total: tierPrices.discountedTotal,
    plan: planName,
  });
  const buttonText = t('checkoutModal.payButton', {
    total: tierPrices.discountedTotal,
    plan: planName,
  });

  if (catalogError) {
    console.error('[offer-checkout] %s', catalogError);
    return (
      <p role="alert" style={{ fontSize: 14, lineHeight: 1.6, color: '#b3261e' }}>
        {t('checkoutModal.errors.checkout_unavailable')}
      </p>
    );
  }

  return (
    <>
      <SolidgateCheckout
        productId={tier.productId}
        sessionId={sessionId}
        price={priceCaption}
        buttonText={buttonText}
        onSuccess={onSuccess}
        onAccepted={onAccepted}
        onProcessingChange={onProcessingChange}
        intent={true}
        locale={locale}
        loadingLabel={t('checkoutModal.loadingPaymentForm')}
        processingLabel={t('checkoutModal.processing')}
        pendingNotice={t('checkoutModal.paymentPending')}
        grantingNotice={t('checkoutModal.confirmingPayment')}
        genericError={t('checkoutModal.errors.generic')}
        errorMessages={CHECKOUT_ERROR_CODES.reduce<Record<string, string>>((acc, code) => {
          acc[code] = t(`checkoutModal.errors.${code}`);
          return acc;
        }, {})}
      />
      <div
        style={{
          marginTop: 20,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 11,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#238653' }}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M7 10V7a5 5 0 0 1 10 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <rect x="4" y="10" width="16" height="11" rx="2.5" stroke="currentColor" strokeWidth="2" />
            <path d="M12 14v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 12, lineHeight: 1.25, fontWeight: 700, textAlign: 'center' }}>
            {t('pricing.trust.secure')}
          </span>
        </div>

        <div
          aria-label="Visa, Mastercard, American Express, Discover, 3D Secure"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 6 }}
        >
          <PaymentBadge>
            <span style={{ color: '#1434cb', fontSize: 14, fontWeight: 900, fontStyle: 'italic', letterSpacing: '-0.08em' }}>VISA</span>
          </PaymentBadge>
          <PaymentBadge ariaLabel="Mastercard">
            <span style={{ position: 'relative', display: 'block', width: 28, height: 16 }}>
              <span style={{ position: 'absolute', left: 1, top: 1, width: 14, height: 14, borderRadius: '50%', background: '#eb001b' }} />
              <span style={{ position: 'absolute', right: 1, top: 1, width: 14, height: 14, borderRadius: '50%', background: '#f79e1b', opacity: 0.9 }} />
            </span>
          </PaymentBadge>
          <PaymentBadge>
            <span style={{ padding: '2px 4px', borderRadius: 2, background: '#1677b8', color: '#fff', fontSize: 9, fontWeight: 900, letterSpacing: '-0.04em' }}>AMEX</span>
          </PaymentBadge>
          <PaymentBadge>
            <span style={{ color: '#1d2433', fontSize: 8, fontWeight: 800, letterSpacing: '-0.04em' }}>DISC<span style={{ color: '#f58220' }}>O</span>VER</span>
          </PaymentBadge>
          <PaymentBadge ariaLabel="3D Secure">
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#238653', fontSize: 8, fontWeight: 800 }}>
              <span aria-hidden="true">🔒</span> 3D SECURE
            </span>
          </PaymentBadge>
        </div>
      </div>
    </>
  );
}

function PaymentBadge({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) {
  return (
    <span
      aria-label={ariaLabel}
      style={{
        height: 27,
        minWidth: 46,
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        borderRadius: 5,
        background: '#fff',
        border: '1px solid rgba(31,24,51,0.13)',
        boxShadow: '0 2px 7px rgba(38,22,67,0.08)',
      }}
    >
      {children}
    </span>
  );
}
