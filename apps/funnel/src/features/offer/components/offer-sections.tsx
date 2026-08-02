'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { resolveProductPrice, type Locale, type ProductId } from '@repo/shared/price-map';
import { formatPrice } from '@repo/shared/format-price';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';
import {
  OFFER_PICKER_PRODUCT_IDS,
  type MainProductId,
  type OfferPickerId,
} from '../config/offer-data';

/**
 * Reusable, product-agnostic building blocks for the offer pages.
 *
 * These are deliberately plain: inline SVG and CSS only, no image assets, no
 * marketing claims. Restyle or replace them freely — the only piece the
 * payment path depends on is `computeTierPrices`, which produces the strings
 * interpolated into the checkout modal's price caption and pay button.
 *
 * TODO(new product): replace the copy in `messages/en/offer.json` and restyle.
 */

// ─── Pricing math (load-bearing — the checkout modal reads this) ─────────────

// All main tiers are 1-week intro periods with a monthly rebill; only the
// first charge differs. PLAN_DAYS / PLAN_MONTHS keep the per-day and per-month
// captions consistent across them.
const PLAN_MONTHS: Record<MainProductId, number> = {
  trial1: 1,
  trial2: 1,
  trial3: 1,
  trial4: 1,
  trial_monthly: 1,
  special_1eur: 1,
  special_free: 1,
};

const PLAN_DAYS: Record<MainProductId, number> = {
  trial1: 7,
  trial2: 7,
  trial3: 7,
  trial4: 7,
  trial_monthly: 30,
  special_1eur: 7,
  special_free: 7,
};

export function computeTierPrices(
  productId: MainProductId,
  discountPct: number,
  locale: Locale,
): {
  discountedTotal: string;
  originalTotal: string;
  monthlyPrice: string;
  dailyPrice: string;
  discountedAmountCents: number;
} {
  const resolved = resolveProductPrice(productId as ProductId, locale);
  const fullCents = resolved.amountCents;
  const anchorCents = resolved.compareAtCents ?? fullCents;
  const discountedCents = Math.round(fullCents * (1 - discountPct / 100));
  const months = PLAN_MONTHS[productId];
  const monthlyCents = Math.round(discountedCents / months);
  const days = PLAN_DAYS[productId];
  const dailyCents = Math.round(discountedCents / days);
  return {
    discountedTotal: formatPrice(discountedCents, resolved.currency, locale),
    originalTotal: formatPrice(anchorCents, resolved.currency, locale),
    monthlyPrice: formatPrice(monthlyCents, resolved.currency, locale),
    dailyPrice: formatPrice(dailyCents, resolved.currency, locale),
    discountedAmountCents: discountedCents,
  };
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

const SECTION_PAD = '56px 22px';
export const OFFER_NAV_HEIGHT = 60;

/** Neutral placeholder wordmark. Swap for your own logo. */
export function BrandGlyph({ size = 24 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={BOILERPLATE_BRAND.shortName}
      style={{ color: 'currentColor', display: 'block' }}
    >
      <rect x="2.5" y="2.5" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function OfferTopNav({ tagline }: { tagline?: string } = {}) {
  const t = useTranslations('offer');
  const taglineText = tagline ?? t('nav.tagline');

  return (
    <nav
      style={{
        borderBottom: '1px solid var(--hairline)',
        background: 'var(--paper)',
        position: 'sticky',
        top: 0,
        zIndex: 40,
        height: OFFER_NAV_HEIGHT,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          height: '100%',
          padding: '0 22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink)' }}>
          <BrandGlyph size={24} />
          <span className="serif" style={{ fontSize: 22, letterSpacing: '0.02em' }}>
            {BOILERPLATE_BRAND.shortName}
          </span>
        </div>
        {taglineText && (
          <span className="mono-up lm-nav-tagline" style={{ opacity: 0.55 }}>
            {taglineText}
          </span>
        )}
      </div>
      <style>{`
        @media (max-width: 720px) {
          .lm-nav-tagline { display: none; }
        }
      `}</style>
    </nav>
  );
}

/** Small decorative sparkle for CTA buttons. Purely ornamental. */
export function CtaSparkle({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'relative',
        width: 18,
        height: 18,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" style={{ color: 'currentColor' }}>
        <path d="M7 0 L8 6 L14 7 L8 8 L7 14 L6 8 L0 7 L6 6 Z" fill="currentColor" />
      </svg>
      <span
        style={{
          position: 'absolute',
          top: side === 'left' ? 0 : 'auto',
          bottom: side === 'left' ? 'auto' : 0,
          right: side === 'left' ? -3 : 'auto',
          left: side === 'left' ? 'auto' : -3,
          width: 3,
          height: 3,
          borderRadius: '50%',
          background: 'currentColor',
          opacity: 0.65,
        }}
      />
    </span>
  );
}

/**
 * Money-back seal. The number of days comes from i18n so it stays in lockstep
 * with the refund window stated in the legal pages — do not hardcode it.
 */
export function GuaranteeSeal({
  size = 132,
  ariaLabel,
  topText,
  daysText,
  daysValue,
}: {
  size?: number;
  ariaLabel?: string;
  topText?: string;
  daysText?: string;
  daysValue?: string;
}) {
  const t = useTranslations('offer');
  const resolvedAriaLabel = ariaLabel ?? t('guarantee.sealAriaLabel');
  const resolvedTopText = topText ?? t('guarantee.sealTopText');
  const resolvedDaysText = daysText ?? t('guarantee.sealDays');
  const resolvedDaysValue = daysValue ?? t('guarantee.sealDaysValue');
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.49;
  const rBand = size * 0.4;
  const rInner = size * 0.34;
  const labelRadius = size * 0.445;

  const ticks = Array.from({ length: 24 }, (_, i) => {
    const a = (i * 15 - 90) * (Math.PI / 180);
    const tickStart = rOuter - size * 0.022;
    return {
      x1: cx + Math.cos(a) * tickStart,
      y1: cy + Math.sin(a) * tickStart,
      x2: cx + Math.cos(a) * rOuter,
      y2: cy + Math.sin(a) * rOuter,
    };
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={resolvedAriaLabel}
      style={{ color: 'var(--ink)', display: 'block' }}
    >
      <defs>
        <path
          id="offerSealLabelTop"
          d={`M ${cx - labelRadius},${cy} a ${labelRadius},${labelRadius} 0 1,1 ${labelRadius * 2},0`}
          fill="none"
        />
      </defs>
      <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke="currentColor" strokeWidth="0.7" />
      <circle cx={cx} cy={cy} r={rBand} fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.45" />
      <circle cx={cx} cy={cy} r={rInner} fill="none" stroke="currentColor" strokeWidth="0.6" opacity="0.35" />
      <g stroke="currentColor" strokeWidth="0.6" opacity="0.55">
        {ticks.map((tk, i) => (
          <line key={i} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} />
        ))}
      </g>
      <text fill="currentColor" fontSize={size * 0.052} letterSpacing={size * 0.018} fontWeight={600}>
        <textPath href="#offerSealLabelTop" startOffset="50%" textAnchor="middle">
          {resolvedTopText}
        </textPath>
      </text>
      <text
        x={cx}
        y={cy - size * 0.05}
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize={size * 0.22}
        fontWeight={500}
      >
        {resolvedDaysValue}
      </text>
      <text
        x={cx}
        y={cy + size * 0.115}
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize={size * 0.045}
        letterSpacing={size * 0.024}
        opacity={0.6}
      >
        {resolvedDaysText}
      </text>
    </svg>
  );
}

export function OfferGuarantee() {
  const t = useTranslations('offer');
  return (
    <section style={{ padding: SECTION_PAD, maxWidth: 720, margin: '0 auto' }}>
      <div
        style={{
          border: '1px solid var(--hairline-strong)',
          padding: '28px 24px',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 24,
          alignItems: 'center',
        }}
      >
        <GuaranteeSeal size={112} />
        <div>
          <h2 className="serif" style={{ fontSize: 24, margin: '0 0 10px', color: 'var(--ink)' }}>
            {t('guarantee.headline')}
          </h2>
          <p style={{ fontSize: 15, lineHeight: 1.6, opacity: 0.78, margin: 0 }}>
            {t('guarantee.description')}
          </p>
        </div>
      </div>
    </section>
  );
}

export function OfferFAQ() {
  const t = useTranslations('offer');
  let items: { question: string; answer: string }[] = [];
  try {
    const raw = t.raw('faq');
    if (Array.isArray(raw)) items = raw as { question: string; answer: string }[];
  } catch {
    items = [];
  }
  if (items.length === 0) return null;

  return (
    <section id="faq" style={{ padding: SECTION_PAD, maxWidth: 720, margin: '0 auto' }}>
      <h2
        className="mono-up"
        style={{ fontSize: 11, letterSpacing: '0.24em', opacity: 0.55, margin: 0 }}
      >
        {t('faqSection.sectionLabel')}
      </h2>
      <div style={{ borderTop: '1px solid var(--ink)', marginTop: 20 }}>
        {items.map((item, i) => (
          <FAQItem key={i} question={item.question} answer={item.answer} />
        ))}
      </div>
    </section>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid var(--hairline)' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          padding: '16px 0',
          background: 'transparent',
          border: 'none',
          color: 'var(--ink)',
          fontFamily: 'inherit',
          fontSize: 16,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span>{question}</span>
        <span aria-hidden style={{ opacity: 0.5 }}>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && (
        <p style={{ margin: '0 0 16px', fontSize: 15, lineHeight: 1.6, opacity: 0.78 }}>{answer}</p>
      )}
    </div>
  );
}

/** Appears once the buyer has scrolled past the first viewport. */
export function StickyOfferCta({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations('offer');
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 520);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        background: 'var(--paper)',
        borderTop: '1px solid var(--hairline-strong)',
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom))',
      }}
    >
      <button
        type="button"
        onClick={onContinue}
        className="tap mono-up"
        style={{
          display: 'flex',
          width: '100%',
          maxWidth: 520,
          margin: '0 auto',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: '16px 22px',
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
        {t('stickyCta.text')}
        <CtaSparkle side="right" />
      </button>
    </div>
  );
}

// ─── Trial price picker (the /offer entry screen) ────────────────────────────

interface OfferTrialPricePickerProps {
  selectedId: OfferPickerId;
  onSelect: (id: OfferPickerId) => void;
  onContinue: () => void;
}

/**
 * "Pick what feels right" price picker. All four amounts are resolved from
 * PRICE_MAP via locale → currency; the highest one doubles as the anchor.
 */
export function OfferTrialPricePicker({
  selectedId,
  onSelect,
  onContinue,
}: OfferTrialPricePickerProps) {
  const t = useTranslations('offer');
  const locale = useLocale() as Locale;

  const resolved = OFFER_PICKER_PRODUCT_IDS.map((id) => resolveProductPrice(id, locale));
  const currency = resolved[0]!.currency;
  const fmt = (cents: number) => formatPrice(cents, currency, locale);
  const options = OFFER_PICKER_PRODUCT_IDS.map((id, index) => ({
    id,
    price: fmt(resolved[index]!.amountCents),
  }));
  const anchor = fmt(resolved[resolved.length - 1]!.amountCents);

  return (
    <section
      style={{ maxWidth: 640, margin: '0 auto', padding: '64px 22px 96px', textAlign: 'center' }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--ink)',
          marginBottom: 28,
        }}
      >
        <BrandGlyph size={20} />
        <span className="serif" style={{ fontSize: 18, letterSpacing: '0.04em' }}>
          {BOILERPLATE_BRAND.shortName}
        </span>
      </div>

      <h1
        className="serif"
        style={{
          fontSize: 'clamp(28px, 4.6vw, 44px)',
          lineHeight: 1.08,
          color: 'var(--ink)',
          margin: 0,
        }}
      >
        {t('pricePicker.headline')}
      </h1>

      <div className="mono-up" style={{ opacity: 0.6, marginTop: 28, marginBottom: 10 }}>
        {t('pricePicker.block1.eyebrow')}
      </div>
      <p style={{ fontSize: 17, lineHeight: 1.5, margin: 0, color: 'var(--ink)' }}>
        {t('pricePicker.block1.body')}
      </p>

      <div className="mono-up" style={{ opacity: 0.6, marginTop: 28, marginBottom: 10 }}>
        {t('pricePicker.block2.eyebrow')}
      </div>
      <p style={{ fontSize: 17, lineHeight: 1.5, margin: 0, color: 'var(--ink)' }}>
        {t('pricePicker.block2.body', { anchor })}
      </p>

      {/* Always a single row, including on narrow phones. */}
      <div
        style={{
          marginTop: 32,
          display: 'flex',
          gap: 'clamp(6px, 1.6vw, 12px)',
          justifyContent: 'center',
          flexWrap: 'nowrap',
        }}
      >
        {options.map((option) => {
          const isSelected = selectedId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              aria-pressed={isSelected}
              className="tap"
              style={{
                flex: '1 1 0',
                minWidth: 0,
                padding: 'clamp(11px, 2.2vw, 14px) clamp(6px, 2vw, 22px)',
                fontSize: 'clamp(13px, 3.6vw, 17px)',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                color: isSelected ? 'var(--accent-ink)' : 'var(--ink)',
                background: isSelected ? 'var(--accent)' : 'var(--paper)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--hairline-strong)'}`,
                cursor: 'pointer',
                fontWeight: 500,
                transition: 'background .15s ease, color .15s ease, border-color .15s ease',
              }}
            >
              {option.price}
            </button>
          );
        })}
      </div>

      <p
        style={{
          marginTop: 18,
          marginLeft: 'auto',
          marginRight: 'auto',
          fontSize: 15,
          lineHeight: 1.5,
          color: 'var(--ink)',
          opacity: 0.75,
          maxWidth: 480,
        }}
      >
        {t('pricePicker.anchorHint', { anchor })}
      </p>

      <button
        type="button"
        onClick={onContinue}
        className="tap mono-up"
        style={{
          marginTop: 40,
          padding: '20px 36px',
          background: 'var(--accent)',
          color: 'var(--accent-ink)',
          border: '1px solid var(--ink)',
          fontSize: 11,
          letterSpacing: '0.22em',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minWidth: 260,
          fontFamily: 'inherit',
        }}
      >
        {t('pricePicker.cta')}
      </button>
    </section>
  );
}
