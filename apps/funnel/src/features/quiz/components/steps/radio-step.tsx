'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { RadioStep } from '@/features/quiz/config/quiz-schema';
import { useQuizStore } from '@/stores/quiz-store';
import { renderTemplated, resolveToPlainText } from '@/features/quiz/lib/templated-text';
import { getOptionRowStyle } from './_option-card-style';

interface RadioStepProps {
  step: RadioStep;
  t: ReturnType<typeof useTranslations>;
  selectedValue: string | undefined;
  onSelect: (nextStepId: string, storeAs: string, value: string, label: string) => void;
}

export function RadioStep({ step, t, selectedValue, onSelect }: RadioStepProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const answers = useQuizStore((s) => s.answers);
  const questionTemplate = t.raw(step.question) as string;
  const subtitleTemplate = step.subtitle ? (t.raw(step.subtitle) as string) : '';

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
        // Resolve the label to plain text (gender form + any markers) before
        // storing — answer labels are re-displayed in summaries / copy.
        const label = resolveToPlainText(
          t.raw(option.label) as string,
          answers as Record<string, unknown>,
        );
        onSelect(option.nextStepId, step.storeAs, option.value, label);
      }, 200);
    },
    [step.options, step.storeAs, onSelect, clearTimer, t, answers],
  );

  useEffect(() => setPendingValue(null), [step.stepId]);
  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 22px 80px' }}>
      {step.tagline && (
        <div className="mono-up" style={{ opacity: 0.55, marginBottom: 14 }}>
          {t(step.tagline)}
        </div>
      )}
      <h2
        id={`step-${step.stepId}`}
        className="serif"
        style={{
          fontSize: 'clamp(20px, 5.4vw, 25px)',
          lineHeight: 1.1,
          color: 'var(--ink)',
          margin: 0,
        }}
      >
        {renderTemplated(questionTemplate, answers as Record<string, unknown>)}
      </h2>

      {subtitleTemplate && (
        <p
          className="serif-it"
          style={{
            fontSize: 18,
            lineHeight: 1.4,
            color: 'var(--ink-soft)',
            opacity: 0.78,
            margin: '14px 0 0',
            maxWidth: 560,
          }}
        >
          {renderTemplated(subtitleTemplate, answers as Record<string, unknown>)}
        </p>
      )}

      <div role="radiogroup" aria-labelledby={`step-${step.stepId}`} style={{ marginTop: 36 }}>
        {step.options.map((option, i) => {
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
              style={getOptionRowStyle({ isActive, isLast: i === step.options.length - 1 })}
            >
              {option.icon ? (
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 28,
                    fontSize: 22,
                    lineHeight: 1,
                    textAlign: 'center',
                  }}
                >
                  {option.icon}
                </span>
              ) : (
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    border: `1px solid ${isActive ? 'var(--accent-ink)' : 'var(--ink)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: isActive ? 'var(--accent-ink)' : 'transparent',
                      transition: 'background .2s ease',
                    }}
                  />
                </span>
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  className="serif"
                  style={{ display: 'block', fontSize: 22, lineHeight: 1.2 }}
                >
                  {renderTemplated(
                    t.raw(option.label) as string,
                    answers as Record<string, unknown>,
                  )}
                </span>
                {option.subtitle && (
                  <span
                    className="serif-it"
                    style={{
                      display: 'block',
                      fontSize: 14,
                      opacity: isActive ? 0.75 : 0.6,
                      marginTop: 2,
                    }}
                  >
                    {renderTemplated(
                      t.raw(option.subtitle) as string,
                      answers as Record<string, unknown>,
                    )}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
