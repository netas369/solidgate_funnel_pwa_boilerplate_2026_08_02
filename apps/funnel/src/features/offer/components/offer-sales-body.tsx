'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { resolveProductPrice, type Locale, type ProductId } from '@repo/shared/price-map';
import { formatPrice } from '@repo/shared/format-price';
import {
  CtaSparkle,
  OfferFAQ,
  OfferGuarantee,
  OfferTopNav,
  StickyOfferCta,
} from './offer-sections';

/**
 * The neutral sales body rendered on /offer/details (and the two
 * special-offer variants).
 *
 * Prop contract is fixed by `offer-details-page.tsx`: swap the internals for
 * your own marketing sections, but keep `onUnlock` as the ONLY way the page
 * opens the checkout modal — the page owns the analytics and the modal state.
 *
 * TODO(new product): replace every section below. All copy lives in
 * `messages/en/offer.json` under `salesBody.*`, `pricing.*` and `faq`.
 */
export interface OfferSalesBodyProps {
  /** The selected tier's PRICE_MAP key; null before a tier resolves. */
  productId: ProductId | null;
  preview?: boolean;
  /** True while the checkout modal is mounted (suppresses the sticky CTA). */
  checkoutOpen: boolean;
  onUnlock: () => void;
}

export function OfferSalesBody({
  productId,
  preview = false,
  checkoutOpen,
  onUnlock,
}: OfferSalesBodyProps) {
  const t = useTranslations('offer');
  const locale = useLocale() as Locale;

  const price = useMemo(() => {
    if (!productId) return null;
    const resolved = resolveProductPrice(productId, locale);
    const rebill = resolveProductPrice('trial_monthly', locale);
    return {
      today: formatPrice(resolved.amountCents, resolved.currency, locale),
      compareAt:
        resolved.compareAtCents !== undefined
          ? formatPrice(resolved.compareAtCents, resolved.currency, locale)
          : null,
      rebill: formatPrice(rebill.amountCents, rebill.currency, locale),
    };
  }, [productId, locale]);

  const bullets = useMemo(() => {
    try {
      const raw = t.raw('salesBody.bullets');
      return Array.isArray(raw) ? (raw as string[]) : [];
    } catch {
      return [];
    }
  }, [t]);

  return (
    <>
      <OfferTopNav />

      {/* Hero — a plain gradient band, no image assets. */}
      <section
        style={{
          padding: '56px 22px',
          textAlign: 'center',
          background: 'linear-gradient(180deg, var(--paper-soft, #f6f4ef) 0%, var(--paper) 100%)',
        }}
      >
        <div style={{ maxWidth: 660, margin: '0 auto' }}>
          <div
            className="mono-up"
            style={{ fontSize: 10, letterSpacing: '0.3em', opacity: 0.55, marginBottom: 14 }}
          >
            {t('salesBody.eyebrow')}
          </div>
          <h1
            className="serif"
            style={{
              fontSize: 'clamp(30px, 5.4vw, 46px)',
              lineHeight: 1.08,
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            {t('salesBody.headline')}
          </h1>
          <p
            style={{
              fontSize: 17,
              lineHeight: 1.6,
              color: 'var(--ink)',
              opacity: 0.78,
              margin: '18px auto 0',
              maxWidth: 520,
            }}
          >
            {t('salesBody.subheadline')}
          </p>
        </div>
      </section>

      {/* What's included */}
      {bullets.length > 0 && (
        <section style={{ padding: '8px 22px 48px', maxWidth: 660, margin: '0 auto' }}>
          <h2
            className="mono-up"
            style={{ fontSize: 11, letterSpacing: '0.24em', opacity: 0.55, margin: '0 0 16px' }}
          >
            {t('salesBody.includedLabel')}
          </h2>
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 12,
              borderTop: '1px solid var(--hairline)',
              paddingTop: 18,
            }}
          >
            {bullets.map((bullet, index) => (
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
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Pricing card — the ONE place that opens the checkout. */}
      <section
        id="offer-pricing"
        style={{ padding: '0 22px 56px', maxWidth: 520, margin: '0 auto' }}
      >
        <div
          style={{
            border: '1px solid var(--ink)',
            padding: '28px 24px',
            textAlign: 'center',
            background: 'var(--paper)',
          }}
        >
          <div
            className="mono-up"
            style={{ fontSize: 10, letterSpacing: '0.26em', opacity: 0.6, marginBottom: 12 }}
          >
            {t('pricing.heading.eyebrow')}
          </div>
          <div className="serif" style={{ fontSize: 40, lineHeight: 1, color: 'var(--ink)' }}>
            {price?.compareAt && (
              <s style={{ opacity: 0.4, marginRight: 12, fontSize: 24 }}>{price.compareAt}</s>
            )}
            {price?.today ?? '—'}
          </div>
          <p style={{ marginTop: 12, fontSize: 13, lineHeight: 1.55, opacity: 0.72 }}>
            {t('pricing.card.note', { rebill: price?.rebill ?? '' })}
          </p>

          <button
            type="button"
            onClick={onUnlock}
            className="tap mono-up"
            style={{
              marginTop: 22,
              width: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: '20px 22px',
              background: 'var(--accent)',
              color: 'var(--accent-ink)',
              border: '1px solid var(--ink)',
              fontSize: 11,
              letterSpacing: '0.22em',
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            <CtaSparkle side="left" />
            {t('pricing.card.cta')}
            <CtaSparkle side="right" />
          </button>

          <p style={{ marginTop: 14, fontSize: 11, lineHeight: 1.55, opacity: 0.6 }}>
            {t('pricing.disclaimer')}
          </p>
        </div>
      </section>

      <OfferGuarantee />
      <OfferFAQ />

      <div style={{ height: 96 }} />

      {/* Suppressed while the modal is up: the buyer is already in checkout,
          and a second CTA underneath the overlay is a focus trap hazard. */}
      {!checkoutOpen && !preview && <StickyOfferCta onContinue={onUnlock} />}
    </>
  );
}
