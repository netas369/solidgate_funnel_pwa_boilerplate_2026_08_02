'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import type { useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'motion/react';
import type { TrialPriceStep } from '@/features/quiz/config/quiz-schema';
import { resolveProductPrice, type Locale, type ProductId } from '@repo/shared/price-map';
import { formatPrice } from '@repo/shared/format-price';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';
import { useQuizStore } from '@/stores/quiz-store';
import { QuizNav } from './quiz-nav';

interface TrialPriceStepProps {
  step: TrialPriceStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string) => void | Promise<void>;
  onBack: () => void;
}

// One family, several weights — the display serif is retired across the quiz,
// so hierarchy here comes from size and weight rather than a second typeface.
const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const INK = '#241f38';
const INK_STRONG = '#0e0f23';
const LABEL = '#574a73';
const FOOTNOTE = '#443a5e';
// Deeper than the quiz's #7f4cf2 chrome accent: this one carries body copy on
// the lavender gradient, where the lighter purple only reaches ~3.2:1.
const ACCENT = '#6329cf';
const HAIRLINE = 'rgba(98,57,192,0.30)';
const SELECTED_BG = 'linear-gradient(211deg, #29234f 4%, #432f7d 47%, #28214e 95%)';

/** Rule broken by a small rotated square — the divider under the headline. */
function DiamondRule() {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', maxWidth: 360 }}
    >
      <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, transparent, ${HAIRLINE})` }} />
      <span style={{ width: 6, height: 6, flexShrink: 0, transform: 'rotate(45deg)', background: ACCENT }} />
      <span style={{ flex: 1, height: 1, background: `linear-gradient(270deg, transparent, ${HAIRLINE})` }} />
    </div>
  );
}

/** Small-caps label above a paragraph of copy. */
function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(4px, 0.9dvh, 9px)', textAlign: 'center', width: '100%' }}>
      <p
        style={{
          margin: 0,
          fontSize: 'clamp(9.5px, 1.35dvh, 11px)',
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: LABEL,
        }}
      >
        {label}
      </p>
      <p
        style={{
          margin: 0,
          fontSize: 'clamp(13.5px, min(3.9vw, 2.05dvh), 17px)',
          fontWeight: 300,
          lineHeight: 1.5,
          color: INK,
          textWrap: 'pretty',
        }}
      >
        {children}
      </p>
    </div>
  );
}

export function TrialPriceStepView({ step, t, onContinue, onBack }: TrialPriceStepProps) {
  const locale = useLocale() as Locale;
  const reduceMotion = useReducedMotion();

  const priced = step.tiers.map((tier) => {
    const p = resolveProductPrice(tier as ProductId, locale);
    return { tier, label: formatPrice(p.amountCents, p.currency, locale) };
  });
  // The highest displayed tier is interpolated into the explanatory copy.
  const fullPrice = priced[priced.length - 1]?.label ?? '';

  const savedTier = useQuizStore((state) => state.answers[step.storeAs]);
  const initialTier =
    typeof savedTier === 'string' && step.tiers.includes(savedTier)
      ? savedTier
      : step.defaultTier;
  const [selected, setSelected] = useState(initialTier);
  const [continuing, setContinuing] = useState(false);

  const handleContinue = async () => {
    if (continuing) return;
    const chosen = priced.find((p) => p.tier === selected) ?? priced[0];
    if (chosen) useQuizStore.getState().setStepAnswer(step.storeAs, chosen.tier, chosen.label);
    setContinuing(true);
    try {
      await onContinue(step.nextStepId);
    } catch (error) {
      setContinuing(false);
      throw error;
    }
  };

  // Staggered settle for the editorial stack. Reduced motion gets the finished
  // state immediately rather than a slower version of the same movement.
  const rise = (i: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.5, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        // One screen, always. dvh only — never 100vh (mobile URL-bar jitter).
        height: '100dvh',
        fontFamily: FONT_SANS,
        color: INK,
        background: 'linear-gradient(180deg, #f0edfa 0%, #c0a2e5 100%)',
        overflow: 'hidden',
      }}
    >
      <style>{`
        .trialPriceContinueArrow { transform: none; }
        [dir='rtl'] .trialPriceContinueArrow { transform: rotate(180deg); }
        /* One row like the reference wherever it fits. The widest formatted
           price across our locales is ~78px (NT$653.49), so four chips plus
           padding need ~430px of viewport; below that they pair up rather than
           squeeze the amounts. */
        .trialPriceTiers { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: clamp(6px, 1.1dvh, 10px); width: 100%; }
        @media (max-width: 430px) {
          .trialPriceTiers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
      `}</style>

      <div
        style={{
          width: '100%',
          maxWidth: 480,
          margin: '0 auto',
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // Emergency fallback only (landscape phones / absurd translations):
          // every vertical value below is dvh-scaled so this never triggers in
          // normal portrait use.
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <QuizNav onBack={onBack} backLabel={t('ui.back')} />

        {/* Editorial stack — the only shrinkable band, so the nav and the CTA
            stay pinned and visible no matter how long the translation is. */}
        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'safe center',
            gap: 'clamp(12px, 2.6dvh, 26px)',
            padding: 'clamp(2px, 0.7dvh, 8px) 22px clamp(6px, 1.4dvh, 14px)',
            width: '100%',
          }}
        >
          {/* Brand lockup — sits directly under the nav glyph so the two read
              as one mark rather than repeating the symbol. */}
          <motion.p
            {...rise(0)}
            style={{
              margin: 0,
              fontSize: 'clamp(9.5px, 1.3dvh, 11px)',
              fontWeight: 500,
              letterSpacing: '0.26em',
              textTransform: 'uppercase',
              color: '#6a5a8c',
            }}
          >
            {BOILERPLATE_BRAND.name}
          </motion.p>

          <motion.div {...rise(1)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(10px, 2.1dvh, 20px)', width: '100%' }}>
            <h1
              style={{
                margin: 0,
                fontWeight: 500,
                fontSize: 'clamp(21px, min(6.2vw, 3.3dvh), 33px)',
                lineHeight: 1.15,
                letterSpacing: '-0.015em',
                color: INK_STRONG,
                textAlign: 'center',
                textWrap: 'balance',
              }}
            >
              {t(step.title)}
            </h1>
            <DiamondRule />
          </motion.div>

          <motion.div {...rise(2)} style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(12px, 2.5dvh, 24px)', width: '100%', maxWidth: 400 }}>
            <Block label={t(step.eyebrow)}>
              {t.rich(step.intro, {
                accent: (chunks) => <span style={{ color: ACCENT, fontWeight: 400 }}>{chunks}</span>,
              })}
            </Block>
            <Block label={t(step.cardEyebrow)}>{t(step.cardBody, { price: fullPrice })}</Block>
          </motion.div>

          <motion.div {...rise(3)} style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(8px, 1.6dvh, 14px)', alignItems: 'center', width: '100%' }}>
            <div className="trialPriceTiers">
              {priced.map(({ tier, label }) => {
                const isSelected = tier === selected;
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setSelected(tier)}
                    aria-pressed={isSelected}
                    style={{
                      minWidth: 0,
                      // 44px floor keeps the tap target legal once the dvh
                      // clamps below bottom out on short phones.
                      minHeight: 44,
                      height: 'clamp(44px, 6.2dvh, 54px)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 6px',
                      borderRadius: 12,
                      cursor: 'pointer',
                      fontFamily: FONT_SANS,
                      fontWeight: isSelected ? 500 : 400,
                      fontSize: 'clamp(14px, min(4.2vw, 2.4dvh), 18px)',
                      textAlign: 'center',
                      whiteSpace: 'nowrap',
                      WebkitTapHighlightColor: 'transparent',
                      transition: 'background .18s ease, color .18s ease, border-color .18s ease, transform .18s ease',
                      ...(isSelected
                        ? {
                            background: SELECTED_BG,
                            border: '1px solid #6239c0',
                            color: '#ffffff',
                            boxShadow: '0 8px 20px rgba(80,50,130,0.30)',
                          }
                        : {
                            background: 'rgba(255,255,255,0.55)',
                            border: '1px solid rgba(98,57,192,0.18)',
                            color: INK_STRONG,
                          }),
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 'clamp(11px, 1.6dvh, 13px)',
                fontStyle: 'italic',
                fontWeight: 300,
                lineHeight: 1.5,
                color: FOOTNOTE,
                textAlign: 'center',
                maxWidth: 340,
                textWrap: 'pretty',
              }}
            >
              {t(step.note, { price: fullPrice })}
            </p>
          </motion.div>
        </div>

        {/* Footer CTA */}
        <div
          style={{
            padding:
              'clamp(8px, calc(4dvh - 16px), 16px) 32px calc(clamp(8px, calc(4dvh - 16px), 16px) + env(safe-area-inset-bottom))',
            width: '100%',
            flex: '0 0 auto',
          }}
        >
          <button
            type="button"
            onClick={handleContinue}
            disabled={continuing}
            className="tap"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              padding: 'clamp(9px, 1.7dvh, 14px) 20px',
              minHeight: 48,
              borderRadius: 100,
              border: '2px solid rgba(185,135,251,0.59)',
              background: 'linear-gradient(201deg, #4f397e 16%, #704ebf 49%, #402b6f 85%)',
              color: '#ffffff',
              fontFamily: FONT_SANS,
              fontWeight: 600,
              fontSize: 'clamp(13px, 1.9dvh, 15px)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              cursor: continuing ? 'wait' : 'pointer',
              opacity: continuing ? 0.7 : 1,
              boxShadow: '0 12px 28px rgba(80,50,130,0.4)',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {t(step.buttonLabel)}
            <svg className="trialPriceContinueArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M0 8.16667L15.5 8.16667C14.7033 8.16667 13.7133 8.64583 12.8967 9.145C11.8075 9.81083 10.8575 10.6833 10.0625 11.6833C9.44417 12.4583 8.83333 13.3817 8.83333 14M15.5 8.16667C14.7033 8.16667 13.7125 7.6875 12.8967 7.18833C11.8075 6.52167 10.8575 5.64917 10.0625 4.65083C9.44417 3.875 8.83333 2.95 8.83333 2.33333"
                stroke="#ffffff"
                strokeWidth="1.4"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
