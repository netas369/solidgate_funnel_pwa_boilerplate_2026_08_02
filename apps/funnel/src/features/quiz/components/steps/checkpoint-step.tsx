'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { useTranslations } from 'next-intl';
import type { CheckpointStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface CheckpointStepProps {
  step: CheckpointStep;
  t: ReturnType<typeof useTranslations>;
  answers: Record<string, string | string[] | number>;
  onContinue: (nextStepId: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";

// Floating theme-label pills, scattered around the central illustration.
// Positions are percentages of the (full-width) stage so they scale with it.
interface Slot {
  left?: string;
  right?: string;
  top: string;
  rotate: number;
  opacity: number;
  dur: number;
  delay: number;
}
const SLOTS: Slot[] = [
  { left: '1%', top: '3%', rotate: -9, opacity: 0.85, dur: 6, delay: 0 },
  { right: '1%', top: '1%', rotate: 6, opacity: 0.8, dur: 7, delay: 0.6 },
  { left: '2%', top: '17%', rotate: 9, opacity: 0.9, dur: 6.5, delay: 1.1 },
  { right: '2%', top: '20%', rotate: -8, opacity: 0.62, dur: 7.5, delay: 0.3 },
  { left: '2%', top: '64%', rotate: -15, opacity: 0.5, dur: 6.2, delay: 0.9 },
  { right: '1%', top: '62%', rotate: -4, opacity: 0.42, dur: 7.2, delay: 1.4 },
  { left: '4%', top: '80%', rotate: 10, opacity: 0.32, dur: 6.8, delay: 0.5 },
  { right: '5%', top: '82%', rotate: 17, opacity: 0.22, dur: 7.8, delay: 1.2 },
];

function pillBg(opacity: number) {
  return `linear-gradient(200deg, rgba(41,35,79,${opacity}) 4%, rgba(67,47,125,${opacity}) 47%, rgba(40,33,78,${opacity}) 95%)`;
}

export function CheckpointStepView({
  step,
  t,
  answers,
  onContinue,
  onBack,
  progress,
}: CheckpointStepProps) {
  const reduceMotion = useReducedMotion();
  const key = String(answers[step.variantBy] ?? '');
  const variant = step.variants[key] ?? step.variants[step.fallbackVariant];
  if (!variant) return null;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        minHeight: '100dvh',
        fontFamily: FONT_SANS,
        color: '#ffffff',
        overflowX: 'hidden',
      }}
    >
      <style>{`
        .checkpointContinueArrow { transform: rotate(180deg); }
        [dir='rtl'] .checkpointContinueArrow { transform: none; }
      `}</style>

      {/* Full-bleed backdrop so there's no seam against the page on desktop.
          Pure CSS — layer an <img> in here once you have artwork. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #1d092c 0%, #2f0a5e 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(38,24,71,0.3) 0%, rgba(28,16,58,0.3) 100%)' }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 480, margin: '0 auto', height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QuizNav onBack={onBack} backLabel={t('ui.back')} />

        {/* Title + subtitle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '4px 16px 8px' }}>
          <h2
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'clamp(20px, 5.4vw, 25px)',
              lineHeight: 1.13,
              color: '#ffffff',
              textAlign: 'center',
            }}
          >
            {t(variant.title)}
          </h2>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 300, lineHeight: '21px', color: '#cec1d6', textAlign: 'center' }}>
            {t(variant.subtitle)}
          </p>
        </div>

        {/* Stage: central illustration ringed by floating theme pills */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px 0',
            minHeight: 0,
          }}
        >
          <StepImage
            src={step.image}
            style={{
              height: 'clamp(280px, 44vh, 400px)',
              width: step.image ? 'auto' : 'clamp(240px, 70%, 340px)',
              maxWidth: '78%',
              objectFit: 'cover',
              borderRadius: '48% / 42%',
            }}
          />

          {variant.labels.map((label, idx) => {
            const slot = SLOTS[idx];
            if (!slot) return null;
            const pill = (
              <div
                style={{
                  transform: `rotate(${slot.rotate}deg)`,
                  padding: '5px 10px',
                  borderRadius: 18,
                  border: '1px solid #6239c0',
                  background: pillBg(slot.opacity),
                  backdropFilter: 'blur(5px)',
                  WebkitBackdropFilter: 'blur(5px)',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  fontWeight: 300,
                  color: '#ffffff',
                  boxShadow: '0 4px 14px rgba(10,6,24,0.35)',
                }}
              >
                {t(label)}
              </div>
            );
            const wrapStyle: React.CSSProperties = {
              position: 'absolute',
              top: slot.top,
              ...(slot.left !== undefined ? { left: slot.left } : {}),
              ...(slot.right !== undefined ? { right: slot.right } : {}),
              zIndex: 2,
              pointerEvents: 'none',
            };
            return reduceMotion ? (
              <div key={idx} style={wrapStyle}>{pill}</div>
            ) : (
              <motion.div
                key={idx}
                style={wrapStyle}
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: slot.dur, ease: 'easeInOut', repeat: Infinity, delay: slot.delay }}
              >
                {pill}
              </motion.div>
            );
          })}
        </div>

        {/* Continue */}
        <div style={{ padding: '8px 50px 12px' }}>
          <button
            type="button"
            onClick={() => onContinue(step.nextStepId)}
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
            <svg className="checkpointContinueArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
    </div>
  );
}
