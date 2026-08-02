'use client';

import { useCallback, useState } from 'react';
import { useLocale, type useTranslations } from 'next-intl';
import type { InputGroupStep } from '@/features/quiz/config/quiz-schema';
import { useQuizStore } from '@/stores/quiz-store';
import { NAME_KEYS } from '@/features/quiz/lib/name';
import { renderTemplated } from '@/features/quiz/lib/templated-text';
import { QuizNav } from './quiz-nav';
import { WheelDatePicker, WheelTimePicker } from './wheel-pickers';

// Live capitalization for name fields: uppercase the first letter of each word
// as the user types. Only changes case (never length), so the input caret stays
// put. The final value is still normalized by titleCase() on submit.
function capitalizeWords(s: string): string {
  return s.replace(/(^|\s)(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

interface InputGroupStepProps {
  step: InputGroupStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string, fieldValues: Record<string, string | number>) => void;
  onBack?: () => void;
  onSkip?: () => void;
}

const FONT_SERIF = "var(--font-display), Georgia, serif";
const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const INK = '#0e0f23';
const ACCENT = '#7f4cf2';

export function InputGroupStep({ step, t, onContinue, onBack }: InputGroupStepProps) {
  const locale = useLocale();
  const answers = useQuizStore((s) => s.answers);
  const questionTemplate = t.raw(step.question) as string;
  const subtextTemplate = step.subtext ? (t.raw(step.subtext) as string) : '';

  // Which example name to show. Only 'male' gets the masculine one; non-binary
  // visitors — and anyone who somehow reached this step without answering
  // step 1 — see the feminine example.
  const exampleGender = answers['gender'] === 'male' ? 'male' : 'female';

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      step.fields.map((field) => {
        const saved = answers[field.storeAs];
        return [
          field.storeAs,
          typeof saved === 'string' || typeof saved === 'number' ? String(saved) : '',
        ];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = useCallback((storeAs: string, raw: string) => {
    const next = NAME_KEYS.has(storeAs) ? capitalizeWords(raw) : raw;
    setValues((prev) => ({ ...prev, [storeAs]: next }));
    setErrors((prev) => ({ ...prev, [storeAs]: '' }));
  }, []);

  const isDateComplete = useCallback((v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v), []);
  const isTimeComplete = useCallback((v: string) => /^\d{2}:\d{2}$/.test(v), []);

  const allFilled = step.fields.every((f) => {
    const v = (values[f.storeAs] ?? '').trim();
    if (f.optional) return true;
    if (f.inputType === 'date') return isDateComplete(v);
    if (f.inputType === 'time') return isTimeComplete(v);
    return v.length > 0;
  });

  const handleSubmit = useCallback(() => {
    const newErrors: Record<string, string> = {};
    const out: Record<string, string | number> = {};

    for (const field of step.fields) {
      const v = (values[field.storeAs] ?? '').trim();
      if (!v && !field.optional) {
        newErrors[field.storeAs] = t('ui.continue');
        continue;
      }
      if (field.inputType === 'date' && v && !isDateComplete(v)) {
        newErrors[field.storeAs] = t('ui.continue');
        continue;
      }
      if (field.inputType === 'time' && v && !isTimeComplete(v)) {
        newErrors[field.storeAs] = t('ui.continue');
        continue;
      }
      if (v) out[field.storeAs] = v;
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    onContinue(step.nextStepId, out);
  }, [step.fields, step.nextStepId, values, onContinue, t, isDateComplete, isTimeComplete]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        // Locked to exactly one viewport: the step owns the whole screen
        // (no progress header above it) and must never scroll the page.
        // dvh only — never vh — so mobile browser chrome is accounted for.
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: INK,
        background: 'linear-gradient(180deg, #f0edfa 0%, #c0a2e5 100%)',
        overflow: 'hidden',
      }}
    >
      <div style={{ width: '100%', maxWidth: 480, margin: '0 auto', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <QuizNav onBack={onBack ?? (() => {})} backLabel={t('ui.back')} />

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: 'clamp(4px, 1dvh, 8px) 22px clamp(10px, 4.7dvh, 40px)',
            // Emergency fallback only (landscape phones / absurdly long
            // translations). Every value below is dvh-scaled so that in normal
            // portrait use — 320x568 through 430x932 — this never triggers.
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          <h1
            style={{
              margin: 0,
              flex: '0 0 auto',
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'clamp(18px, min(5.8vw, 3.6dvh), 28px)',
              lineHeight: 1.12,
              color: INK,
              textAlign: 'center',
            }}
          >
            {renderTemplated(questionTemplate, answers as Record<string, unknown>)}
          </h1>
          {subtextTemplate && (
            <p
              style={{
                margin: 'clamp(6px, 1.5dvh, 12px) 0 0',
                flex: '0 0 auto',
                fontSize: 'clamp(12px, 2dvh, 15px)',
                lineHeight: 1.5,
                color: '#51536c',
                textAlign: 'center',
              }}
            >
              {renderTemplated(subtextTemplate, answers as Record<string, unknown>)}
            </p>
          )}

          <div style={{ flex: '0 0 auto', marginTop: 'clamp(14px, 3.7dvh, 28px)', display: 'flex', flexDirection: 'column', gap: 'clamp(10px, 2.6dvh, 20px)' }}>
            {step.fields.map((field) => {
              const inputType = field.inputType ?? 'text';
              const id = `lm-input-${field.storeAs}`;
              const placeholder = field.placeholder
                ? t(field.placeholderByGender ? `${field.placeholder}.${exampleGender}` : field.placeholder)
                : undefined;
              const error = errors[field.storeAs];

              if (inputType === 'date') {
                return (
                  <WheelDatePicker
                    key={field.storeAs}
                    value={values[field.storeAs] ?? ''}
                    onChange={(iso) => handleChange(field.storeAs, iso)}
                    locale={locale}
                    label={t(field.label)}
                    error={error}
                    t={t}
                  />
                );
              }

              if (inputType === 'time') {
                return (
                  <WheelTimePicker
                    key={field.storeAs}
                    value={values[field.storeAs] ?? ''}
                    onChange={(time) => handleChange(field.storeAs, time)}
                    label={t(field.label)}
                    error={error}
                    t={t}
                  />
                );
              }

              return (
                <label key={field.storeAs} htmlFor={id} style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 'clamp(12px, 1.7dvh, 13px)', color: '#51536c', marginBottom: 'clamp(4px, 1.1dvh, 8px)' }}>
                    {t(field.label)}
                  </span>
                  <input
                    id={id}
                    type={inputType}
                    value={values[field.storeAs]}
                    placeholder={placeholder}
                    autoComplete={field.autoComplete}
                    autoCapitalize={NAME_KEYS.has(field.storeAs) ? 'words' : undefined}
                    required={!field.optional}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? `${id}-error` : undefined}
                    onChange={(e) => handleChange(field.storeAs, e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (allFilled) handleSubmit();
                      }
                    }}
                    style={{
                      width: '100%',
                      background: 'rgba(255,255,255,0.72)',
                      color: INK,
                      border: `1px solid ${error ? '#e5484d' : 'rgba(98,57,192,0.2)'}`,
                      borderRadius: 14,
                      // Vertical padding scales with the viewport; minHeight
                      // guarantees the 44px tap target at the floor.
                      padding: 'clamp(11px, 2dvh, 15px) 16px',
                      minHeight: 44,
                      // NEVER below 16px: iOS Safari auto-zooms the page when a
                      // focused input's font-size is smaller. Not clamped.
                      fontSize: 16,
                      fontFamily: 'inherit',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  {error && (
                    <span id={`${id}-error`} role="alert" style={{ display: 'block', fontSize: 'clamp(12px, 1.7dvh, 13px)', marginTop: 'clamp(4px, 0.9dvh, 6px)', color: '#c0392b' }}>
                      {error}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          {/* Absorbs the leftover space, and is the first thing to collapse
              on short viewports so the controls below stay on screen. */}
          <div style={{ flex: '1 1 auto', minHeight: 0 }} />

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allFilled}
            className="tap"
            style={{
              width: '100%',
              flex: '0 0 auto',
              marginTop: 'clamp(14px, 3.7dvh, 28px)',
              background: ACCENT,
              color: '#ffffff',
              border: 'none',
              borderRadius: 100,
              padding: 'clamp(12px, 2.3dvh, 17px) 22px',
              minHeight: 48,
              fontSize: 'clamp(15px, 2.2dvh, 16px)',
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: !allFilled ? 'not-allowed' : 'pointer',
              opacity: !allFilled ? 0.45 : 1,
              transition: 'opacity 0.2s ease',
              boxShadow: '0 10px 26px rgba(127,76,242,0.35)',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {t('ui.continue')}
          </button>
          {step.fields.some((f) => f.optional) && !allFilled && (
            <div style={{ flex: '0 0 auto', marginTop: 'clamp(6px, 1.6dvh, 12px)', textAlign: 'center' }}>
              <button
                type="button"
                onClick={() => onContinue(step.nextStepId, {})}
                className="tap"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#51536c',
                  fontSize: 'clamp(12px, 1.9dvh, 14px)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textDecoration: 'underline',
                }}
              >
                {t('ui.skip')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
