'use client';

import type { useTranslations } from 'next-intl';
import type { ExpertNoteStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface ExpertNoteStepProps {
  step: ExpertNoteStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const INK = '#0e0f23';
const BODY = '#241f38';
const MUTED = '#4a3f66';
// Deeper than the quiz's #7f4cf2 chrome accent: this one carries heading text
// on the lavender gradient, where the lighter purple only reaches ~3.2:1.
const ACCENT = '#6329cf';
const VERIFIED = '#1f8a5f';

export function ExpertNoteStepView({ step, t, onContinue, onBack, progress }: ExpertNoteStepProps) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 480,
        margin: '0 auto',
        // One screen, always. dvh only — never 100vh (mobile URL-bar jitter).
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: BODY,
      }}
    >
      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'safe center',
          gap: 'clamp(12px, 2.4dvh, 24px)',
          padding: 'clamp(4px, 1dvh, 10px) 22px clamp(6px, 1.4dvh, 14px)',
          width: '100%',
        }}
      >
        {/* Hero illustration with the expert card seated inside it — equal
            insets on the left, right and bottom so it reads as one object. */}
        <div
          style={{
            width: '100%',
            maxWidth: 340,
            flexShrink: 0,
            position: 'relative',
            borderRadius: 22,
            overflow: 'hidden',
            border: '1px solid rgba(98,57,192,0.12)',
            boxShadow: '0 10px 28px rgba(80,50,130,0.14)',
          }}
        >
          <StepImage
            src={step.heroImage}
            style={{
              display: 'block',
              width: '100%',
              height: 'clamp(180px, 30dvh, 270px)',
              objectFit: 'cover',
            }}
          />

          <div
            style={{
              position: 'absolute',
              left: 12,
              right: 12,
              bottom: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 12px',
              borderRadius: 14,
              background: 'rgba(255,255,255,0.94)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              boxShadow: '0 6px 18px rgba(20,10,40,0.18)',
            }}
          >
            <StepImage
              src={step.image}
              style={{
                width: 44,
                height: 44,
                flexShrink: 0,
                borderRadius: 12,
                objectFit: 'cover',
                objectPosition: '50% 22%',
                background: 'rgba(98,57,192,0.08)',
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  color: VERIFIED,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="7" fill={VERIFIED} />
                  <path d="M5 8.2 L7 10.2 L11 6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t(step.badgeLabel)}
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.25 }}>
                {step.expertName}
              </span>
              <span style={{ fontSize: 12, fontWeight: 300, color: MUTED, lineHeight: 1.3 }}>
                {t(step.expertTitle)}
              </span>
            </div>
          </div>
        </div>

        <h1
          style={{
            margin: 0,
            maxWidth: 400,
            fontWeight: 500,
            fontSize: 'clamp(17px, min(4.9vw, 2.5dvh), 25px)',
            lineHeight: 1.28,
            letterSpacing: '-0.01em',
            color: INK,
            textAlign: 'center',
            textWrap: 'balance',
          }}
        >
          {t.rich(step.title, {
            accent: (chunks) => <span style={{ color: ACCENT }}>{chunks}</span>,
          })}
        </h1>

        <p
          style={{
            margin: 0,
            maxWidth: 380,
            fontSize: 'clamp(12.5px, min(3.6vw, 1.85dvh), 15px)',
            fontWeight: 300,
            lineHeight: 1.5,
            color: MUTED,
            textAlign: 'center',
            textWrap: 'pretty',
          }}
        >
          {t(step.body)}
        </p>
      </div>

      <div style={{ flexShrink: 0, padding: '8px 32px 12px' }}>
        <button
          type="button"
          onClick={() => onContinue(step.nextStepId)}
          className="tap"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: 'clamp(9px, 1.7dvh, 14px) 20px',
            minHeight: 48,
            borderRadius: 100,
            border: '2px solid rgba(185,135,251,0.59)',
            background: 'linear-gradient(201deg, #4f397e 16%, #704ebf 49%, #402b6f 85%)',
            color: '#ffffff',
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 'clamp(13px, 1.9dvh, 15px)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            boxShadow: '0 12px 28px rgba(80,50,130,0.4)',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {t(step.buttonLabel)}
        </button>
      </div>

      <QuizProgressArc progress={progress} />
    </div>
  );
}
