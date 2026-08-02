'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { TextSelectStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { QuizProgressArc } from './quiz-progress-arc';

interface TextSelectStepProps {
  step: TextSelectStep;
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
const ACCENT = '#7f4cf2';
const ACTIVE_BG = 'linear-gradient(194deg, #29234f 4%, #432f7d 47%, #28214e 95%)';

function RightArrow({ color }: { color: string }) {
  return (
    <svg className="textSelectArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M16 7.83333L0.5 7.83333C1.29667 7.83333 2.28667 7.35417 3.10333 6.855C4.1925 6.18917 5.1425 5.31667 5.9375 4.31667C6.55583 3.54167 7.16667 2.61833 7.16667 2M0.5 7.83333C1.29667 7.83333 2.2875 8.3125 3.10333 8.81167C4.1925 9.47833 5.1425 10.3508 5.9375 11.3492C6.55583 12.125 7.16667 13.05 7.16667 13.6667"
        stroke={color}
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function TextSelectStepView({
  step,
  t,
  selectedValue,
  onSelect,
  onBack,
  progress,
}: TextSelectStepProps) {
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
      <style>{`
        .textSelectArrow { transform: rotate(180deg); }
        [dir='rtl'] .textSelectArrow { transform: none; }
      `}</style>

      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      {/* Question + answer list. Centered when it fits; falls back to a scroll
          within this region on very short viewports so the footer arc stays
          pinned flush at the bottom. */}
      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          // Two-point ramps: each value lands on its 844dvh design number and
          // bottoms out at its floor exactly at 568dvh (small-phone worst case).
          gap: 'clamp(6px, calc(4.55dvh - 19.83px), 24px)',
          padding:
            'clamp(2px, calc(2.95dvh - 14.77px), 12px) clamp(12px, calc(5.71vw - 6.27px), 16px) clamp(2px, calc(4.17dvh - 21.69px), 20px)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(2px, calc(3.62dvh - 18.56px), 12px)', padding: '0 4px' }}>
          <h2
            id={`step-${step.stepId}`}
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'min(clamp(20px, 5.4vw, 25px), max(17px, calc(1.47dvh + 8.65px)))',
              lineHeight: 1.13,
              color: INK,
              textAlign: 'center',
            }}
          >
            {t(step.question)}
          </h2>
          {subtitleText && (
            <p style={{ margin: 0, fontSize: 'clamp(12px, calc(0.72dvh + 7.92px), 14px)', fontWeight: 300, lineHeight: 1.5, color: MUTED, textAlign: 'center' }}>
              {subtitleText}
            </p>
          )}
        </div>

        <div
          role="radiogroup"
          aria-labelledby={`step-${step.stepId}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(4px, calc(2.22dvh - 8.61px), 14px)', width: '100%' }}
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
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'clamp(6px, 2vw, 8px)',
                  width: '100%',
                  minHeight: 'clamp(44px, calc(6.69dvh + 6px), 74px)',
                  padding:
                    'clamp(4px, calc(1.61dvh - 5.15px), 16px) clamp(10px, calc(8vw - 15.6px), 16px)',
                  borderRadius: 18,
                  textAlign: 'start',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  border: isActive ? '2px solid transparent' : '2px solid rgba(154,38,255,0.12)',
                  background: isActive ? ACTIVE_BG : '#f6f4f6',
                  boxShadow: isActive
                    ? '0 8px 24px rgba(127,76,242,0.35)'
                    : '0 1px 2px rgba(14,15,35,0.04)',
                  transition: 'background .2s ease, box-shadow .2s ease, transform .2s ease',
                  transform: isActive ? 'translateY(-1px)' : 'none',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'clamp(6px, 2vw, 8px)',
                    flex: '1 1 0',
                    minWidth: 0,
                  }}
                >
                  {option.icon && (
                    <span
                      aria-hidden="true"
                      style={{ fontSize: 'min(clamp(20px, 5.5vw, 22px), max(16px, calc(1.97dvh + 4.82px)))', lineHeight: 1, flexShrink: 0 }}
                    >
                      {option.icon}
                    </span>
                  )}
                  <span
                    style={{
                      flex: '1 1 0',
                      minWidth: 0,
                      fontSize: option.icon
                        ? 'min(clamp(15px, 4vw, 16px), max(13px, calc(0.94dvh + 7.67px)))'
                        : 'clamp(13px, calc(1.09dvh + 6.8px), 16px)',
                      fontWeight: 300,
                      lineHeight: 1.25,
                      color: isActive ? '#ffffff' : INK,
                    }}
                  >
                    {t(option.label)}
                  </span>
                </span>
                <RightArrow color={isActive ? '#ffffff' : ACCENT} />
              </button>
            );
          })}
        </div>
      </div>

      <QuizProgressArc progress={progress} />
    </div>
  );
}
