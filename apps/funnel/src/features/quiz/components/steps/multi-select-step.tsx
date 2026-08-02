'use client';

import { useCallback } from 'react';
import type { useTranslations } from 'next-intl';
import type { MultiSelectStep } from '@/features/quiz/config/quiz-schema';
import { useQuizStore } from '@/stores/quiz-store';
import { renderTemplated, resolveToPlainText } from '@/features/quiz/lib/templated-text';
import { BottomBar } from './_bottom-bar';
import { getOptionRowStyle } from './_option-card-style';

interface MultiSelectStepProps {
  step: MultiSelectStep;
  t: ReturnType<typeof useTranslations>;
  selectedValues: string[];
  onToggle: (storeAs: string, value: string, maxSelection?: number) => void;
  onContinue: (nextStepId: string, storeAs: string, values: string[], labels: string[]) => void;
}

export function MultiSelectStep({
  step,
  t,
  selectedValues,
  onToggle,
  onContinue,
}: MultiSelectStepProps) {
  const answers = useQuizStore((s) => s.answers);

  const handleToggle = useCallback(
    (value: string) => onToggle(step.storeAs, value, step.maxSelection),
    [step.storeAs, step.maxSelection, onToggle],
  );

  const handleContinue = useCallback(() => {
    const labels = step.options
      .filter((o) => selectedValues.includes(o.value))
      // Resolve to plain text (gender form + markers) before storing — labels
      // are re-displayed in summaries / copy interpolation.
      .map((o) =>
        resolveToPlainText(t.raw(o.label) as string, answers as Record<string, unknown>),
      );
    onContinue(step.nextStepId, step.storeAs, selectedValues, labels);
  }, [step.options, step.nextStepId, step.storeAs, selectedValues, onContinue, t, answers]);

  const hint = step.maxSelection
    ? t('ui.multiHint', { count: step.maxSelection })
    : t('ui.multiHintBare');

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 22px 140px' }}>
      <div className="mono-up" style={{ opacity: 0.55, marginBottom: 14 }}>
        {hint}
      </div>
      <h2
        className="serif"
        style={{
          fontSize: 'clamp(20px, 5.4vw, 25px)',
          lineHeight: 1.1,
          color: 'var(--ink)',
          margin: 0,
        }}
      >
        {renderTemplated(t.raw(step.question) as string, answers as Record<string, unknown>)}
      </h2>

      <div style={{ marginTop: 36 }}>
        {step.options.map((option, i) => {
          const isActive = selectedValues.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={isActive}
              onClick={() => handleToggle(option.value)}
              className="tap"
              style={getOptionRowStyle({ isActive, isLast: i === step.options.length - 1 })}
            >
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  border: `1px solid ${isActive ? 'var(--accent-ink)' : 'var(--ink)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                {isActive ? '✓' : ''}
              </span>
              <span
                className="serif"
                style={{ flex: 1, fontSize: 21, lineHeight: 1.2 }}
              >
                {renderTemplated(
                  t.raw(option.label) as string,
                  answers as Record<string, unknown>,
                )}
              </span>
            </button>
          );
        })}
      </div>

      <BottomBar maxWidth={720}>
        <button
          type="button"
          onClick={handleContinue}
          disabled={selectedValues.length === 0}
          className="tap mono-up"
          style={{
            width: '100%',
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            border: '1px solid var(--ink)',
            padding: '18px 22px',
            fontSize: 11,
            letterSpacing: '0.22em',
            cursor: selectedValues.length === 0 ? 'not-allowed' : 'pointer',
            opacity: selectedValues.length === 0 ? 0.4 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          {t('ui.continue')}
        </button>
      </BottomBar>
    </div>
  );
}
