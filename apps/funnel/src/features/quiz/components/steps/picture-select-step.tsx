'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { PictureSelectStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface PictureSelectStepProps {
  step: PictureSelectStep;
  t: ReturnType<typeof useTranslations>;
  selectedValue: string | undefined;
  onSelect: (nextStepId: string, storeAs: string, value: string, label: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";
const INK = '#0e0f23';
const ACCENT = '#7f4cf2';
// Bottom-up dark scrim so the white label reads over any illustration.
const CARD_SCRIM =
  'linear-gradient(to top, rgba(10,11,46,0.89) 16%, rgba(10,11,46,0.24) 29%, rgba(10,11,46,0) 39%)';

export function PictureSelectStepView({
  step,
  t,
  selectedValue,
  onSelect,
  onBack,
  progress,
}: PictureSelectStepProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleSelect = useCallback(
    (optionValue: string) => {
      const option = step.options.find((o) => o.value === optionValue);
      if (!option) return;
      clearTimer();
      setPendingValue(optionValue);
      timerRef.current = setTimeout(() => {
        onSelect(option.nextStepId, step.storeAs, option.value, t(option.label));
      }, 200);
    },
    [step.options, step.storeAs, onSelect, clearTimer, t],
  );

  useEffect(() => setPendingValue(null), [step.stepId]);
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
      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      {/* Question + answer grid. The whole screen is locked to the viewport
          (root height:100dvh, footer arc pinned below); this middle region
          shrinks to fit — the grid's max-width is derived from the leftover
          height so the square cards never push the arc off-screen. `safe
          center` keeps it centered when it fits and falls back to top-aligned
          (no clipping) on very short viewports. */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          gap: 'clamp(14px, 3vh, 24px)',
          padding: 'clamp(8px, 2vh, 16px) 16px clamp(10px, 2vh, 20px)',
        }}
      >
        <h2
          id={`step-${step.stepId}`}
          className="serif"
          style={{
            margin: 0,
            flex: '0 0 auto',
            fontFamily: FONT_SERIF,
            fontWeight: 400,
            fontSize: 'clamp(20px, 5.4vw, 25px)',
            lineHeight: 1.13,
            color: INK,
            textAlign: 'center',
            maxWidth: 340,
          }}
        >
          {t(step.question)}
        </h2>

        <div
          role="radiogroup"
          aria-labelledby={`step-${step.stepId}`}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 'clamp(8px, 1.6vh, 12px)',
            width: '100%',
            // Cap by the column width (312) AND by the height left for 3 rows,
            // so on short phones the cards scale down to fit instead of
            // overflowing. ~250px reserves nav + question + arc + gaps.
            maxWidth: 'min(312px, calc((100dvh - 250px) / 3 * 2))',
            margin: '0 auto',
          }}
        >
          {step.options.map((option) => {
            const isActive =
              pendingValue !== null ? pendingValue === option.value : selectedValue === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => handleSelect(option.value)}
                className="tap"
                style={{
                  position: 'relative',
                  aspectRatio: '1 / 1',
                  borderRadius: 24,
                  overflow: 'hidden',
                  padding: 0,
                  border: `2px solid ${isActive ? ACCENT : 'transparent'}`,
                  boxShadow: isActive
                    ? `0 0 0 1px ${ACCENT}, 0 8px 24px rgba(127,76,242,0.40)`
                    : '0 2px 6px rgba(14,15,35,0.12)',
                  transform: isActive ? 'translateY(-2px)' : 'none',
                  transition: 'border-color .2s ease, box-shadow .2s ease, transform .2s ease',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: '#1a1430',
                }}
              >
                <StepImage
                  src={option.image}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <div style={{ position: 'absolute', inset: 0, background: CARD_SCRIM }} />
                <span
                  style={{
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    bottom: 10,
                    fontSize: 14,
                    fontWeight: 600,
                    lineHeight: '16px',
                    color: '#ffffff',
                    textAlign: 'center',
                  }}
                >
                  {t(option.label)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <QuizProgressArc progress={progress} />
    </div>
  );
}
