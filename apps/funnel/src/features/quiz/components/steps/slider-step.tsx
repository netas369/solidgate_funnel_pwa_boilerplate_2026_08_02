'use client';

import { useCallback, useRef, useState } from 'react';
import { useLocale, type useTranslations } from 'next-intl';
import { getLocaleDir } from '@repo/i18n/routing';
import type { SliderStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface SliderStepProps {
  step: SliderStep;
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

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function SliderStepView({
  step,
  t,
  initialValue,
  onContinue,
  onBack,
  progress,
}: SliderStepProps) {
  const locale = useLocale();
  const isRtl = getLocaleDir(locale) === 'rtl';
  const count = step.states.length;
  const last = count - 1;
  const startIdx = (() => {
    if (initialValue) {
      const i = step.states.findIndex((s) => s.value === initialValue);
      if (i >= 0) return i;
    }
    return step.defaultIndex ?? Math.floor(last / 2);
  })();
  const [selection, setSelection] = useState({ stepId: step.stepId, index: startIdx });
  const index = selection.stepId === step.stepId ? selection.index : startIdx;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const updateIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      setSelection((previous) => {
        const current = previous.stepId === step.stepId ? previous.index : startIdx;
        return {
          stepId: step.stepId,
          index: typeof next === 'function' ? next(current) : next,
        };
      });
    },
    [startIdx, step.stepId],
  );

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const visualPct = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const logicalPct = isRtl ? 1 - visualPct : visualPct;
      updateIndex(clamp(Math.round(logicalPct * last), 0, last));
    },
    [isRtl, last, updateIndex],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragging.current) setFromClientX(e.clientX);
    },
    [setFromClientX],
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0;
      if (e.key === 'ArrowLeft') {
        delta = isRtl ? 1 : -1;
      } else if (e.key === 'ArrowRight') {
        delta = isRtl ? -1 : 1;
      } else if (e.key === 'ArrowDown') {
        delta = -1;
      } else if (e.key === 'ArrowUp') {
        delta = 1;
      } else {
        return;
      }

      if (delta !== 0) {
        e.preventDefault();
        updateIndex((i) => clamp(i + delta, 0, last));
      }
    },
    [isRtl, last, updateIndex],
  );

  const current = step.states[index];
  const pct = last > 0 ? (index / last) * 100 : 0;
  const visualPct = isRtl ? 100 - pct : pct;

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
        .sliderContinueArrow { transform: rotate(180deg); }
        [dir='rtl'] .sliderContinueArrow { transform: none; }
      `}</style>

      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 20px 8px' }}>
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
      </div>

      {/* Stage: morphing arch figure + slider */}
      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          gap: 0,
          padding: '8px 16px 16px',
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        {/* Arch figure — swaps with the slider value */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            maxWidth: 372,
            aspectRatio: '375 / 392',
            borderRadius: '46% 46% 0 0 / 34% 34% 0 0',
            overflow: 'hidden',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 78%, transparent 100%)',
            maskImage: 'linear-gradient(to bottom, #000 78%, transparent 100%)',
          }}
        >
          {step.states.map((s, i) => (
            <StepImage
              key={s.value}
              src={s.image}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                opacity: i === index ? 1 : 0,
                transition: 'opacity .35s ease',
              }}
            />
          ))}
        </div>

        {/* Slider block — centre label + track + end labels */}
        <div style={{ width: '100%', maxWidth: 340, marginTop: -20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              maxWidth: '100%',
              boxSizing: 'border-box',
              padding: '4px clamp(12px, 5vw, 20px)',
              borderRadius: '100px 100px 0 0',
              background: 'linear-gradient(190deg, #29234f 4%, #432f7d 47%, #28214e 95%)',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                display: 'block',
                fontFamily: FONT_SERIF,
                fontSize: 'clamp(16px, 5vw, 20px)',
                lineHeight: 1.35,
                color: '#ffffff',
                overflowWrap: 'break-word',
              }}
            >
              {t(current.label)}
            </span>
          </div>

          {/* Track */}
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-valuemin={0}
            aria-valuemax={last}
            aria-valuenow={index}
            aria-valuetext={t(current.label)}
            aria-labelledby={`step-${step.stepId}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onKeyDown={onKeyDown}
            className="tap"
            style={{
              position: 'relative',
              width: '100%',
              height: 48,
              borderRadius: 100,
              background: 'rgba(240,237,250,0.85)',
              backdropFilter: 'blur(3px)',
              WebkitBackdropFilter: 'blur(3px)',
              boxShadow: 'inset 0 0 0 1px rgba(98,57,192,0.10)',
              cursor: 'pointer',
              touchAction: 'none',
            }}
          >
            {/* base line + filled portion */}
            <div style={{ position: 'absolute', left: 20, right: 20, top: '50%', height: 3, transform: 'translateY(-50%)', background: 'rgba(154,38,255,0.14)', borderRadius: 2 }} />
            <div
              style={{
                position: 'absolute',
                left: isRtl ? 'auto' : 20,
                right: isRtl ? 20 : 'auto',
                width: `calc((100% - 40px) * ${pct / 100})`,
                top: '50%',
                height: 3,
                transform: 'translateY(-50%)',
                background: 'rgba(127,76,242,0.45)',
                borderRadius: 2,
              }}
            />
            {/* stop dots */}
            {step.states.map((s, i) => {
              const p = last > 0 ? (i / last) * 100 : 0;
              const visualP = isRtl ? 100 - p : p;
              return (
                <span
                  key={s.value}
                  style={{
                    position: 'absolute',
                    left: `calc(20px + (100% - 40px) * ${visualP / 100})`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: i <= index ? 'rgba(145,102,200,0.9)' : 'rgba(216,200,240,0.95)',
                    boxShadow: '0 1px 3px rgba(98,57,192,0.3)',
                  }}
                />
              );
            })}
            {/* thumb */}
            <span
              style={{
                position: 'absolute',
                left: `calc(20px + (100% - 40px) * ${visualPct / 100})`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'radial-gradient(circle at 50% 35%, #f0edfa 0%, #cbb9e5 43%, #a685d0 86%, #9166c8 100%)',
                border: '1px solid rgba(98,57,192,0.12)',
                boxShadow: '1px 3px 8px rgba(98,57,192,0.41)',
                pointerEvents: 'none',
              }}
            />
          </div>

        </div>
      </div>

      {/* Continue */}
      <div style={{ padding: '8px 50px 12px' }}>
        <button
          type="button"
          onClick={() => onContinue(step.nextStepId, step.storeAs, current.value, t(current.label))}
          className="tap"
          style={{
            width: '100%',
            display: 'flex',
            gap: 15,
            alignItems: 'center',
            justifyContent: 'center',
            padding: '13px 20px',
            borderRadius: 100,
            border: '2px solid rgba(185,135,251,0.59)',
            background: 'linear-gradient(202deg, #4f397e 16%, #704ebf 49%, #402b6f 85%)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.45px' }}>
            {t(step.buttonLabel)}
          </span>
          <svg className="sliderContinueArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M16 7.83333L0.5 7.83333C1.29667 7.83333 2.28667 7.35417 3.10333 6.855C4.1925 6.18917 5.1425 5.31667 5.9375 4.31667C6.55583 3.54167 7.16667 2.61833 7.16667 2M0.5 7.83333C1.29667 7.83333 2.2875 8.3125 3.10333 8.81167C4.1925 9.47833 5.1425 10.3508 5.9375 11.3492C6.55583 12.125 7.16667 13.05 7.16667 13.6667"
              stroke="#ffffff"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>

      <QuizProgressArc progress={progress} />
    </div>
  );
}
