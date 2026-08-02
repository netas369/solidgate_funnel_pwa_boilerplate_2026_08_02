'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { useTranslations } from 'next-intl';
import type { CheckpointRevealStep } from '@/features/quiz/config/quiz-schema';
import { AutoAdvanceBar, useAutoAdvance } from './_auto-advance';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface CheckpointRevealStepProps {
  step: CheckpointRevealStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";

export function CheckpointRevealStepView({
  step,
  t,
  onContinue,
  onBack,
  progress,
}: CheckpointRevealStepProps) {
  const reduceMotion = useReducedMotion();
  useAutoAdvance(step.stepId, step.nextStepId, onContinue);

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
        /* Decorative mask. \`clip\` keeps it out of the scroll-container role;
           the \`hidden\` line before it is the fallback for Safari < 16, which
           drops the \`clip\` declaration and would otherwise let the rotating
           ring spill outside the circle. */
        .checkpointRevealMask { overflow: hidden; overflow: clip; }
      `}</style>

      {/* Full-bleed backdrop so there's no seam against the page on desktop.
          Pure CSS — layer an <img> in here once you have artwork. */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #1d092c 0%, #2f0a5e 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(38,24,71,0.3) 0%, rgba(28,16,58,0.3) 100%)' }} />
      </div>

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 480, margin: '0 auto', height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QuizNav onBack={onBack} backLabel={t('ui.back')} />

        {/* Title + subtitle + central illustration, vertically centered */}
        <div
          style={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'safe center',
            // two-point ramp: 24px @568dvh -> 40px @844dvh (design value)
            gap: 'clamp(24px, calc(5.80dvh - 8.95px), 40px)',
            padding: '8px 16px 16px',
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
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
              {t(step.title)}
            </h2>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 300, lineHeight: '21px', color: '#cec1d6', textAlign: 'center' }}>
              {t(step.subtitle)}
            </p>
          </div>

          {/* Circular illustration: static base + slowly-rotating symbol ring */}
          <div
            className="checkpointRevealMask"
            style={{
              position: 'relative',
              // width still governed by 74vw at 390x844 (288.6px); the dvh ramp
              // (210px @568dvh -> 300px @844dvh) only takes over on short viewports
              width: 'clamp(200px, min(74vw, calc(32.61dvh + 24.77px)), 315px)',
              flexShrink: 0,
              aspectRatio: '1 / 1',
              borderRadius: '50%',
            }}
          >
            <StepImage
              src={step.image}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
            />
            {step.overlayImage &&
              (reduceMotion ? (
                <img
                  src={step.overlayImage}
                  alt=""
                  aria-hidden="true"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <motion.img
                  src={step.overlayImage}
                  alt=""
                  aria-hidden="true"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  animate={{ rotate: 360 }}
                  transition={{ duration: 60, ease: 'linear', repeat: Infinity }}
                />
              ))}
          </div>
        </div>

        <AutoAdvanceBar />

        <QuizProgressArc progress={progress} />
      </div>
    </div>
  );
}
