'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { ChipSelectStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { QuizProgressArc } from './quiz-progress-arc';

interface ChipSelectStepProps {
  step: ChipSelectStep;
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
const MUTED = '#51536c';
const ACTIVE_BG = 'linear-gradient(194deg, #29234f 4%, #432f7d 47%, #28214e 95%)';

export function ChipSelectStepView({
  step,
  t,
  selectedValue,
  onSelect,
  onBack,
  progress,
}: ChipSelectStepProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    stepId: string;
    value: string;
  } | null>(null);
  const pendingValue = pendingSelection?.stepId === step.stepId ? pendingSelection.value : null;

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
      setPendingSelection({ stepId: step.stepId, value: optionValue });
      timerRef.current = setTimeout(() => {
        onSelect(option.nextStepId, step.storeAs, option.value, t(option.label));
      }, 200);
    },
    [step.options, step.stepId, step.storeAs, onSelect, clearTimer, t],
  );

  useEffect(() => () => clearTimer(), [clearTimer]);

  const subtitleText = step.subtitle ? t(step.subtitle) : '';

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

      {/* Question + chip cloud, vertically centered; footer pinned below. The
          region shrinks to the viewport (scrolls internally only if a very long
          locale overflows a short phone) so the progress arc stays flush. */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          // Two-point ramps: exactly the floor at 568dvh, exactly the design
          // value at 844dvh (dvh only — vh resolves to the LARGE viewport).
          gap: 'clamp(8px, calc(5.8dvh - 24.95px), 24px)',
          // padding-bottom's old 24px max never bound: 2vh at 844 is 16.88px,
          // so 16.88px — not 24px — is the value to preserve at the design size.
          padding:
            'clamp(4px, calc(4.35dvh - 20.71px), 16px) 20px clamp(8px, calc(3.22dvh - 10.3px), 16.88px)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '0 4px' }}>
          <h2
            id={`step-${step.stepId}`}
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'clamp(18px, min(5.4vw, calc(1.11dvh + 11.69px)), 25px)',
              lineHeight: 1.13,
              color: INK,
              textAlign: 'center',
            }}
          >
            {t(step.question)}
          </h2>
          {subtitleText && (
            <p style={{ margin: 0, fontSize: 14, fontWeight: 300, lineHeight: '21px', color: MUTED, textAlign: 'center' }}>
              {subtitleText}
            </p>
          )}
        </div>

        <div
          role="radiogroup"
          aria-labelledby={`step-${step.stepId}`}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'clamp(6px, calc(0.72dvh + 1.92px), 8px)',
            justifyContent: 'center',
            width: '100%',
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  minHeight: 37,
                  paddingBlock: 4,
                  paddingInlineStart: 6,
                  paddingInlineEnd: 10,
                  borderRadius: 18,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  border: isActive ? '1px solid transparent' : '1px solid rgba(154,38,255,0.12)',
                  background: isActive ? ACTIVE_BG : '#f6f4f6',
                  backdropFilter: 'blur(5px)',
                  WebkitBackdropFilter: 'blur(5px)',
                  boxShadow: isActive
                    ? '0 8px 22px rgba(127,76,242,0.32)'
                    : '0 1px 2px rgba(14,15,35,0.04)',
                  transition: 'background .2s ease, box-shadow .2s ease, transform .2s ease',
                  transform: isActive ? 'translateY(-1px)' : 'none',
                }}
              >
                {option.icon && (
                  <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1, padding: 4, flexShrink: 0 }}>
                    {option.icon}
                  </span>
                )}
                <span
                  style={{
                    // Long locales (lt/ru) wrap a label onto a second line on
                    // 568dvh phones, which costs a whole 15px row. A 1px ramp
                    // un-wraps them; 14px/21px is restored by 844dvh.
                    fontSize: 'clamp(13px, calc(0.36dvh + 10.96px), 14px)',
                    fontWeight: 300,
                    lineHeight: 'clamp(19.5px, calc(0.54dvh + 16.44px), 21px)',
                    minWidth: 0,
                    textAlign: 'start',
                    overflowWrap: 'break-word',
                    color: isActive ? '#ffffff' : INK,
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
