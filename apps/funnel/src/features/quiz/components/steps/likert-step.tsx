'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { LikertStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { QuizProgressArc } from './quiz-progress-arc';

interface LikertStepProps {
  step: LikertStep;
  t: ReturnType<typeof useTranslations>;
  initialValue: string | undefined;
  onContinue: (nextStepId: string, storeAs: string, value: string, label: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";
const INK = '#0e0f23';
const MUTED = '#51536c';
// Light tint, not the solid purple used on buttons: the cell has to stay a
// backdrop for the icon that lights up on top of it.
const ACTIVE_CELL_BG = 'linear-gradient(180deg, rgba(185,135,251,0.26) 0%, rgba(127,76,242,0.16) 100%)';

export function LikertStepView({
  step,
  t,
  initialValue,
  onContinue,
  onBack,
  progress,
}: LikertStepProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localSelection, setLocalSelection] = useState<{
    stepId: string;
    value: string;
  } | null>(null);
  const selected =
    localSelection?.stepId === step.stepId ? localSelection.value : (initialValue ?? null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // No Continue button — picking a point IS the answer. The short delay lets the
  // selected state paint before the step transitions, same as text_select.
  const handleSelect = useCallback(
    (value: string) => {
      clearTimer();
      setLocalSelection({ stepId: step.stepId, value });
      timerRef.current = setTimeout(() => {
        onContinue(step.nextStepId, step.storeAs, value, value);
      }, 200);
    },
    [clearTimer, onContinue, step.nextStepId, step.stepId, step.storeAs],
  );

  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 480,
        margin: '0 auto',
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: INK,
      }}
    >
      <style>{`
        /* Pointer devices get a preview of the lit state before committing. */
        @media (hover: hover) {
          .likertCell:hover > span { filter: none; opacity: 0.95; }
        }
        .likertCell:focus-visible { outline: 2px solid #6329cf; outline-offset: -2px; }
        @media (prefers-reduced-motion: reduce) {
          .likertCell, .likertCell > span { transition: none; }
          .likertCell > span { transform: none !important; }
        }
      `}</style>

      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      {/* Question + statement + scale, vertically centered (scrolls within this
          region on very short viewports so the footer arc stays pinned) */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          gap: 'clamp(16px, 3vh, 24px)',
          padding: 'clamp(12px, 2vh, 16px) 20px clamp(14px, 2vh, 24px)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '0 4px' }}>
          <h2
            id={`step-${step.stepId}`}
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'clamp(20px, 5.4vw, 25px)',
              lineHeight: 1.13,
              color: INK,
              textAlign: 'center',
            }}
          >
            {t(step.question)}
          </h2>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 300, lineHeight: '21px', color: MUTED, textAlign: 'center' }}>
            {t(step.statement)}
          </p>
        </div>

        {/* Scale: one segmented control. Icons sit slightly desaturated until
            picked, so the chosen answer reads as the lit one — dimming only, no
            blur: blurring an emoji at this size just makes it look misprinted. */}
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            role="radiogroup"
            aria-labelledby={`step-${step.stepId}`}
            className="likertScale"
            style={{
              display: 'flex',
              width: '100%',
              borderRadius: 20,
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.66)',
              border: '1px solid rgba(98,57,192,0.14)',
              boxShadow: '0 6px 18px rgba(80,50,130,0.10)',
              backdropFilter: 'blur(5px)',
              WebkitBackdropFilter: 'blur(5px)',
            }}
          >
            {step.points.map((point, i) => {
              const isActive = selected === point.value;
              const emojiSize = point.emphasis === 'soft' ? 24 : 30;
              return (
                <button
                  key={point.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  aria-label={point.value}
                  onClick={() => handleSelect(point.value)}
                  className="tap likertCell"
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    // 44px floor keeps the tap target legal on the shortest phones.
                    minHeight: 44,
                    height: 'clamp(56px, 8.4dvh, 68px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    border: 'none',
                    // Hairlines between cells only — the group owns the outline.
                    borderInlineStart: i > 0 ? '1px solid rgba(98,57,192,0.12)' : 'none',
                    background: isActive ? ACTIVE_CELL_BG : 'transparent',
                    boxShadow: isActive ? 'inset 0 0 0 1px rgba(98,57,192,0.22)' : 'none',
                    WebkitTapHighlightColor: 'transparent',
                    transition: 'background .2s ease, box-shadow .2s ease',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      fontSize: emojiSize,
                      lineHeight: 1,
                      display: 'block',
                      filter: isActive ? 'none' : 'grayscale(0.25)',
                      opacity: isActive ? 1 : 0.82,
                      transform: isActive ? 'scale(1.12)' : 'scale(1)',
                      transition: 'filter .22s ease, opacity .22s ease, transform .22s ease',
                    }}
                  >
                    {point.icon}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, width: '100%' }}>
            <span style={{ flex: '1 1 0', minWidth: 0, textAlign: 'start', fontSize: 12, fontWeight: 300, lineHeight: 1.3, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.02em', overflowWrap: 'break-word' }}>
              {t(step.minLabel)}
            </span>
            <span style={{ flex: '1 1 0', minWidth: 0, textAlign: 'end', fontSize: 12, fontWeight: 300, lineHeight: 1.3, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.02em', overflowWrap: 'break-word' }}>
              {t(step.maxLabel)}
            </span>
          </div>
        </div>
      </div>

      <QuizProgressArc progress={progress} />
    </div>
  );
}
