'use client';

import { useLocale, type useTranslations } from 'next-intl';
import { getLocaleDir } from '@repo/i18n/routing';
import type { SocialWallStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { StepImage } from './_step-image';
import { QuizProgressArc } from './quiz-progress-arc';

interface SocialWallStepProps {
  step: SocialWallStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string) => void;
  onBack: () => void;
  progress: number;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const INK = '#0e0f23';
const MUTED = '#4a3f66';
// Deeper than the quiz's #7f4cf2 chrome accent so the highlighted count still
// clears 4.5:1 on the lavender gradient.
const ACCENT = '#6329cf';
const ROW_COUNT = 4;

export function SocialWallStepView({ step, t, onContinue, onBack, progress }: SocialWallStepProps) {
  const textDir = getLocaleDir(useLocale());
  // Deal the chips into rows round-robin so neighbouring rows never start with
  // the same face, whatever the chip count.
  const rows = Array.from({ length: ROW_COUNT }, (_, r) =>
    step.chips.filter((_, i) => i % ROW_COUNT === r),
  ).filter((row) => row.length > 0);

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
        color: INK,
      }}
    >
      <style>{`
        /* The track holds every chip twice, so a -50% shift lands exactly on
           the duplicate and the loop is seamless at any content width. */
        @keyframes socialWallDriftL { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes socialWallDriftR { from { transform: translateX(-50%); } to { transform: translateX(0); } }
        .socialWallTrack { display: flex; gap: 8px; width: max-content; will-change: transform; }
        /* The -50% loop assumes the track starts at the row's left edge. Under
           an rtl page it starts at the right instead and the shift drags it off
           screen, leaving the rows blank. Pin the row's geometry to ltr; each
           chip opts its own contents back into the page direction. */
        .socialWallRow { overflow: hidden; direction: ltr;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
        @media (prefers-reduced-motion: reduce) {
          .socialWallTrack { animation: none !important; transform: translateX(-12%); }
        }
      `}</style>

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
          gap: 'clamp(14px, 2.8dvh, 28px)',
          padding: 'clamp(4px, 1dvh, 10px) 0 clamp(6px, 1.4dvh, 14px)',
          width: '100%',
        }}
      >
        {/* Chip wall */}
        <div
          aria-hidden="true"
          style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}
        >
          {rows.map((row, r) => {
            const doubled = [...row, ...row];
            return (
              <div key={r} className="socialWallRow">
                <div
                  className="socialWallTrack"
                  style={{
                    // Alternating direction and a per-row duration keep the
                    // rows from marching in lockstep.
                    animation: `${r % 2 === 0 ? 'socialWallDriftL' : 'socialWallDriftR'} ${28 + r * 6}s linear infinite`,
                  }}
                >
                  {doubled.map((chip, i) => (
                    <span
                      key={`${r}-${i}`}
                      style={{
                        direction: textDir,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        flexShrink: 0,
                        // Logical, so the tight side stays with the avatar when
                        // the chip flips to rtl.
                        paddingBlock: 6,
                        paddingInlineStart: 6,
                        paddingInlineEnd: 14,
                        borderRadius: 100,
                        background: 'rgba(255,255,255,0.88)',
                        border: '1px solid rgba(98,57,192,0.10)',
                        boxShadow: '0 3px 10px rgba(80,50,130,0.08)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <StepImage
                        src={chip.image}
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          objectFit: 'cover',
                          flexShrink: 0,
                          background: 'rgba(98,57,192,0.08)',
                        }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 400, color: INK }}>
                        {t(chip.label)}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(6px, 1.3dvh, 12px)', padding: '0 22px' }}>
          <h1
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: 'clamp(20px, min(6vw, 3dvh), 30px)',
              lineHeight: 1.2,
              letterSpacing: '-0.015em',
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
              maxWidth: 360,
              fontSize: 'clamp(12.5px, min(3.6vw, 1.85dvh), 15px)',
              fontWeight: 300,
              lineHeight: 1.5,
              color: MUTED,
              textAlign: 'center',
              textWrap: 'pretty',
            }}
          >
            {t(step.subtitle)}
          </p>
        </div>
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
