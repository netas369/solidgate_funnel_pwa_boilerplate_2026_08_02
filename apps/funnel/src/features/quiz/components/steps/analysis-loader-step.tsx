'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { useTranslations } from 'next-intl';
import type { AnalysisLoaderStep } from '@/features/quiz/config/quiz-schema';
import { useQuizStore } from '@/stores/quiz-store';
import { QuizNav } from './quiz-nav';

interface AnalysisLoaderStepProps {
  step: AnalysisLoaderStep;
  t: ReturnType<typeof useTranslations>;
  onContinue: (nextStepId: string) => void;
  onBack: () => void;
}

const FONT_SERIF = "var(--font-display), Georgia, serif";
const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";

// Full-bleed backdrop for the loader. A single CSS gradient rather than an
// image, so the boilerplate ships with no asset dependency — swap in your own
// artwork by layering an <img> behind the content.
const LOADER_BG = 'linear-gradient(180deg, #1d092c 0%, #2f0a5e 100%)';

type Phase = 'running' | 'paused' | 'done';

const MARK_STYLE: React.CSSProperties = {
  width: 'clamp(88px, min(44vw, 24dvh), 175px)',
  height: 'auto',
  maxHeight: 'clamp(88px, 24dvh, 175px)',
  objectFit: 'contain',
  flexShrink: 0,
};

const ORBIT_WRAP_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 'clamp(115px, 23.4dvh, 185px)',
  height: 'clamp(115px, 23.4dvh, 185px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const ORBIT_IMG_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
};

/**
 * Neutral stand-in for a decorative mark: a thick dashed ring that reads as a
 * "working" indicator on its own. Used whenever the step declares no `image`.
 */
function PlaceholderMark({ size }: { size: string | number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        border: '3px dashed rgba(255,255,255,0.42)',
        boxShadow: 'inset 0 0 40px rgba(255,255,255,0.10)',
      }}
    />
  );
}

export function AnalysisLoaderStepView({ step, t, onContinue, onBack }: AnalysisLoaderStepProps) {
  const reduceMotion = useReducedMotion();
  const [percent, setPercent] = useState(0);
  const [activeQuestion, setActiveQuestion] = useState<number | null>(null);
  const [answered, setAnswered] = useState<boolean[]>(() => step.questions.map(() => false));
  const phaseRef = useRef<Phase>('running');
  const startRef = useRef<number>(0);
  const pausedElapsedRef = useRef<number>(0);
  const advancedRef = useRef(false);

  // RAF-driven progress that pauses whenever a question pop-up is shown, then
  // resumes from where it left off. `pausedElapsedRef` carries the elapsed time
  // across the pause so the bar never jumps or restarts on resume.
  useEffect(() => {
    let raf = 0;

    function tick(now: number) {
      if (phaseRef.current !== 'running') return;
      if (!startRef.current) startRef.current = now;

      const elapsed = pausedElapsedRef.current + (now - startRef.current);
      const ratio = Math.min(elapsed / step.durationMs, 1);
      const pct = Math.floor(ratio * 100);
      setPercent(pct);

      // Trigger the next un-answered question whose point we've reached.
      const triggerIdx = step.questions.findIndex((q, i) => !answered[i] && pct >= q.triggerAt);
      if (triggerIdx !== -1) {
        phaseRef.current = 'paused';
        pausedElapsedRef.current = elapsed;
        startRef.current = 0;
        setActiveQuestion(triggerIdx);
        return;
      }

      if (ratio >= 1) {
        phaseRef.current = 'done';
        if (!advancedRef.current) {
          advancedRef.current = true;
          onContinue(step.nextStepId);
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    if (phaseRef.current === 'running') {
      raf = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(raf);
  }, [activeQuestion, answered, onContinue, step.durationMs, step.nextStepId, step.questions]);

  const handleAnswer = (value: 'yes' | 'no') => {
    if (activeQuestion === null) return;
    const q = step.questions[activeQuestion];
    if (q.storeAs) useQuizStore.getState().setStepAnswer(q.storeAs, value);
    setAnswered((prev) => {
      const n = [...prev];
      n[activeQuestion] = true;
      return n;
    });
    setActiveQuestion(null);
    phaseRef.current = 'running';
    startRef.current = 0;
  };

  const phraseIdx = Math.min(
    Math.floor((percent / 100) * step.phrases.length),
    step.phrases.length - 1,
  );

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        // Locked to exactly one screen — the step owns the whole viewport and
        // must never scroll. All vertical sizes below are dvh-scaled to fit.
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: '#ffffff',
      }}
    >
      {/* Backdrop — full-bleed */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', inset: 0, background: LOADER_BG }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(62,0,128,0.3) 0%, rgba(19,0,45,0.3) 100%)' }} />
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth: 480,
          margin: '0 auto',
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          // Emergency fallback only (landscape phones / absurd translations):
          // the dvh clamps below are sized so this never triggers in portrait.
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <QuizNav onBack={onBack} backLabel={t('ui.back')} />

        <div
          style={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'clamp(12px, 4dvh, 32px)',
            padding: 'clamp(10px, 3dvh, 24px) 20px clamp(12px, 5dvh, 40px)',
            minHeight: 0,
          }}
        >
          {reduceMotion ? (
            step.image ? (
              <img src={step.image} alt="" aria-hidden="true" style={MARK_STYLE} />
            ) : (
              <PlaceholderMark size="clamp(88px, min(44vw, 24dvh), 175px)" />
            )
          ) : (
            <motion.div
              style={{ display: 'flex', flexShrink: 0 }}
              animate={{ rotate: 360 }}
              transition={{ duration: 11, ease: 'linear', repeat: Infinity }}
            >
              {step.image ? (
                <img src={step.image} alt="" aria-hidden="true" style={MARK_STYLE} />
              ) : (
                <PlaceholderMark size="clamp(88px, min(44vw, 24dvh), 175px)" />
              )}
            </motion.div>
          )}

          <div
            style={{
              minHeight: 'clamp(46px, 11dvh, 88px)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              width: 'min(300px, 100%)',
            }}
          >
            <AnimatePresence mode="wait">
              <motion.h2
                key={phraseIdx}
                role="status"
                aria-live="polite"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.4 }}
                style={{
                  margin: 0,
                  fontFamily: FONT_SERIF,
                  fontWeight: 400,
                  fontSize: 'clamp(15px, min(5.4vw, 3.2dvh), 25px)',
                  lineHeight: 1.13,
                  color: '#ffffff',
                  textAlign: 'center',
                  textWrap: 'pretty',
                }}
              >
                {t(step.phrases[phraseIdx])}
              </motion.h2>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {activeQuestion !== null && (
        <QuestionPopup
          question={t(step.questions[activeQuestion].question)}
          yesLabel={t(step.questions[activeQuestion].yesLabel)}
          noLabel={t(step.questions[activeQuestion].noLabel)}
          image={step.image}
          reduceMotion={!!reduceMotion}
          onAnswer={handleAnswer}
        />
      )}
    </div>
  );
}

interface QuestionPopupProps {
  question: string;
  yesLabel: string;
  noLabel: string;
  image?: string;
  reduceMotion: boolean;
  onAnswer: (value: 'yes' | 'no') => void;
}

function QuestionPopup({ question, yesLabel, noLabel, image, reduceMotion, onAnswer }: QuestionPopupProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', trapFocus);
    const firstControl = dialog.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled])');
    (firstControl ?? dialog).focus();
    return () => {
      dialog.removeEventListener('keydown', trapFocus);
      previousFocus?.focus();
    };
  }, []);

  // Portaled to <body>: the quiz step renders inside a transformed motion.div,
  // which establishes a containing block — without the portal this overlay's
  // `position: fixed` would anchor to that box instead of the viewport.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={question}
      tabIndex={-1}
      // Portalled to document.body, so it lands outside the page's
      // `.lmRoot.quizType` wrapper and misses the display→sans remap that
      // retires the serif across the quiz. Re-applying the classes here keeps
      // the pop-up in the same typeface as the step behind it.
      className="lmRoot quizType"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(10px, 3dvh, 24px)',
        fontFamily: FONT_SANS,
        background: 'rgba(8, 4, 18, 0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        animation: 'analysisPopFade 240ms ease-out',
      }}
    >
      <div
        style={{
          position: 'relative',
          // Slightly wider than before so the larger question text still wraps
          // to two lines rather than three on a phone.
          maxWidth: 360,
          width: '100%',
          boxSizing: 'border-box',
          // 100% of the overlay's content box, which already subtracts the
          // dvh-scaled overlay padding — stays in sync as that padding shrinks.
          maxHeight: '100%',
          overflowY: 'auto',
          borderRadius: 18,
          overflowX: 'hidden',
          padding: 'clamp(14px, 3.75dvh, 30px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'clamp(8px, 2.25dvh, 18px)',
          alignItems: 'center',
          boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
          animation: 'analysisPopRise 320ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* Card background */}
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 18 }}>
          <div style={{ position: 'absolute', inset: 0, background: LOADER_BG }} />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(38,24,71,0.3) 0%, rgba(28,16,58,0.3) 100%)' }} />
        </div>

        {/* Slowly-orbiting mark behind a "?" glyph */}
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            width: 'clamp(118px, 24dvh, 190px)',
            height: 'clamp(84px, 17.7dvh, 140px)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {reduceMotion ? (
            <div style={ORBIT_WRAP_STYLE}>
              {image ? <img src={image} alt="" aria-hidden="true" style={ORBIT_IMG_STYLE} /> : <PlaceholderMark size="100%" />}
            </div>
          ) : (
            <motion.div
              style={ORBIT_WRAP_STYLE}
              animate={{ rotate: 360 }}
              transition={{ duration: 26, ease: 'linear', repeat: Infinity }}
            >
              {image ? <img src={image} alt="" aria-hidden="true" style={ORBIT_IMG_STYLE} /> : <PlaceholderMark size="100%" />}
            </motion.div>
          )}
          <span
            aria-hidden="true"
            style={{
              position: 'relative',
              zIndex: 1,
              fontFamily: FONT_SERIF,
              fontSize: 'clamp(44px, 10dvh, 76px)',
              lineHeight: 1,
              color: '#ffffff',
            }}
          >
            ?
          </span>
        </div>

        <p
          style={{
            position: 'relative',
            zIndex: 1,
            margin: 0,
            fontFamily: FONT_SERIF,
            fontWeight: 400,
            // Phone-first floor: this is a modal the visitor has to read and
            // answer, so it starts where body copy is comfortable rather than
            // at caption size.
            fontSize: 'clamp(18px, 2.9dvh, 23px)',
            lineHeight: 1.4,
            color: '#ffffff',
            textAlign: 'center',
            textWrap: 'pretty',
          }}
        >
          {question}
        </p>

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 10, width: '100%', flexShrink: 0 }}>
          <AnswerButton label={yesLabel} tone="yes" onClick={() => onAnswer('yes')} />
          <AnswerButton label={noLabel} tone="no" onClick={() => onAnswer('no')} />
        </div>
      </div>

      <style>{`
        @keyframes analysisPopFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes analysisPopRise {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

function AnswerButton({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: 'yes' | 'no';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: '1 0 0',
        minWidth: 0,
        // 44px floor keeps the tap target accessible on the shortest screens.
        height: 'clamp(44px, 5.9dvh, 47px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 100,
        border: '1px solid #ffffff',
        background: 'transparent',
        color: '#ffffff',
        fontFamily: FONT_SANS,
        fontWeight: 600,
        fontSize: 'clamp(16px, 2.2dvh, 18px)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {tone === 'yes' ? (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M4 10.5 L8 14.5 L16 6" stroke="#00AFA3" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5.5 5.5 L14.5 14.5 M14.5 5.5 L5.5 14.5" stroke="#e5484d" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      )}
      <span>{label}</span>
    </button>
  );
}
