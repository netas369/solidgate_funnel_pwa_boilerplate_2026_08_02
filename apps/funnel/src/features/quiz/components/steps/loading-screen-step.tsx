'use client';

import { useEffect, useRef, useState } from 'react';
import type { useTranslations } from 'next-intl';
import type { LoadingScreenStep } from '@/features/quiz/config/quiz-schema';

interface LoadingScreenStepProps {
  step: LoadingScreenStep;
  t: ReturnType<typeof useTranslations>;
  resolvedCopy: (template: string) => string;
  onComplete: () => void;
}

// Neutral loader palette. Move these to CSS custom properties when you theme
// the quiz; they are the only colours this screen owns.
const INK = '#f5ede0';
const INK_SOFT = '#d5c9b8';
const ACCENT = '#d4a55c';
const ACCENT_BRIGHT = '#f0c878';

// Fallback wordmark when the config declares no `brand`. Obvious placeholder on
// purpose — set `brand` in quiz-config.ts (or its i18n key) for your product.
const DEFAULT_BRAND = 'BRAND';

export function LoadingScreenStep({ step, resolvedCopy, onComplete }: LoadingScreenStepProps) {
  // Each phrase: a primary title line + an optional subtitle that appears
  // beneath it. The component cycles through them with a slow crossfade so the
  // wait reads as work being done rather than as a stall.
  const phrases = step.phrases ?? [];
  const total = phrases.length;
  const completedRef = useRef(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [logoVisible, setLogoVisible] = useState(false);

  // Stage timing: split duration evenly across phrases; each phrase has a
  // ~600ms fade in + visible hold + ~500ms fade out. Hold = total/N − fades.
  const perPhraseMs = Math.max(2000, step.durationMs / Math.max(1, total));

  useEffect(() => {
    // Slight delay before the mark crossfades in so the screen feels
    // intentional, not abrupt.
    const t = setTimeout(() => setLogoVisible(true), 220);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    completedRef.current = false;
    const stepTimers = phrases.map((_, i) =>
      setTimeout(() => setActiveIdx(i), i * perPhraseMs),
    );
    const completeTimer = setTimeout(() => {
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
    }, step.durationMs);
    return () => {
      stepTimers.forEach(clearTimeout);
      clearTimeout(completeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.stepId]);

  const brand = step.brand ? resolvedCopy(step.brand) : DEFAULT_BRAND;
  const phrase = phrases[activeIdx];
  const title = phrase ? resolvedCopy(phrase.title) : '';
  const subtitle = phrase?.subtitle ? resolvedCopy(phrase.subtitle) : '';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background:
          'radial-gradient(ellipse at 50% 0%, #1a1442 0%, #0b0a1f 55%, #050410 100%)',
        color: INK,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 28px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Wordmark inside a slowly rotating dotted orbit ring. Entirely CSS —
            no image asset, so the boilerplate renders correctly out of the box. */}
        <div
          style={{
            position: 'relative',
            width: 300,
            height: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: logoVisible ? 1 : 0,
            transform: logoVisible ? 'scale(1)' : 'scale(0.92)',
            transition:
              'opacity 1400ms ease-out, transform 1400ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <HaloDisc />
          <OrbitRing />
          <span
            className="serif"
            style={{
              position: 'relative',
              zIndex: 2,
              fontSize: 20,
              letterSpacing: '0.32em',
              color: INK,
              textTransform: 'uppercase',
              fontWeight: 500,
              textShadow: `0 0 24px ${ACCENT_BRIGHT}88, 0 0 48px ${ACCENT}55, 0 2px 12px #0008`,
            }}
          >
            {brand}
          </span>
        </div>

        {/* Phrase pair — title + subtitle, crossfaded by activeIdx */}
        <div
          style={{
            marginTop: 80,
            minHeight: 120,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            maxWidth: 480,
            width: '100%',
          }}
        >
          <div
            key={activeIdx}
            style={{
              animation: `lmPhraseFade ${perPhraseMs}ms ease-out both`,
            }}
          >
            <h1
              className="serif"
              style={{
                fontSize: 'clamp(20px, 5vw, 27px)',
                lineHeight: 1.2,
                margin: 0,
                color: INK,
                fontWeight: 600,
                letterSpacing: '-0.005em',
              }}
            >
              {title}
            </h1>
            {subtitle && (
              <p
                style={{
                  margin: '10px 0 0',
                  fontSize: 17,
                  lineHeight: 1.4,
                  color: INK_SOFT,
                  opacity: 0.85,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>
      </main>

      <style>{`
        @keyframes lmPhraseFade {
          0%   { opacity: 0; transform: translateY(6px); }
          10%  { opacity: 1; transform: translateY(0); }
          90%  { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-4px); }
        }
        @keyframes lmOrbitSpin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes lmOrbitGlow {
          0%, 100% { opacity: 0.45; }
          50%      { opacity: 0.85; }
        }
        @keyframes lmHaloBreathe {
          0%, 100% { opacity: 0.55; transform: scale(0.97); }
          50%      { opacity: 0.9;  transform: scale(1.02); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-lm-orbit-spin] { animation-duration: 0s !important; }
        }
      `}</style>
    </div>
  );
}

// Soft glowing disc behind the wordmark — the visual anchor that used to be an
// illustration. Pure CSS so it costs nothing and never 404s.
function HaloDisc() {
  return (
    <div
      aria-hidden
      data-lm-orbit-spin
      style={{
        position: 'absolute',
        inset: 30,
        borderRadius: '50%',
        background: `radial-gradient(circle at 50% 45%, ${ACCENT}33 0%, ${ACCENT}14 45%, transparent 70%)`,
        filter: 'drop-shadow(0 0 28px rgba(240, 200, 120, 0.35))',
        animation: 'lmHaloBreathe 6s ease-in-out infinite',
      }}
    />
  );
}

// Dotted orbit ring around the wordmark — 60 little dots tracing a circle,
// slowly rotating with a gentle glow breath.
function OrbitRing() {
  const dots = 60;
  return (
    <div
      aria-hidden
      data-lm-orbit-spin
      style={{
        position: 'absolute',
        inset: 0,
        animation: 'lmOrbitSpin 30s linear infinite, lmOrbitGlow 5s ease-in-out infinite',
      }}
    >
      {Array.from({ length: dots }).map((_, i) => {
        const angle = (i / dots) * Math.PI * 2;
        const r = 96;
        const x = 50 + (Math.cos(angle) * r) / 2.2;
        const y = 50 + (Math.sin(angle) * r) / 2.2;
        const sz = 2 + (i % 5 === 0 ? 1 : 0);
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              top: `${y}%`,
              left: `${x}%`,
              width: sz,
              height: sz,
              borderRadius: '50%',
              background: INK,
              opacity: 0.6,
              transform: 'translate(-50%, -50%)',
              boxShadow: `0 0 4px ${ACCENT_BRIGHT}66`,
            }}
          />
        );
      })}
    </div>
  );
}
