'use client';

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import type { useTranslations } from 'next-intl';
import { getLocaleDir } from '@repo/i18n/routing';
import type { TimeWheelStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { WheelColumn, wheelClamp as clamp } from './wheel-column';

interface TimeWheelStepProps {
  step: TimeWheelStep;
  t: ReturnType<typeof useTranslations>;
  initialValue: string | undefined; // "HH:MM"
  onContinue: (
    nextStepId: string,
    storeAs: string,
    time: { hour: number; minute: number },
  ) => void;
  onBack: () => void;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";
const INK = '#0e0f23';
const MUTED = '#51536c';

export function TimeWheelStepView({ step, t, initialValue, onContinue, onBack }: TimeWheelStepProps) {
  const locale = useLocale();
  const isRtl = getLocaleDir(locale) === 'rtl';
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')), []);

  const parsed = initialValue?.match(/^(\d{2}):(\d{2})$/);
  const initHour = parsed ? Number(parsed[1]) : 12;
  const initMinute = parsed ? Number(parsed[2]) : 30;

  const [hourIdx, setHourIdx] = useState(clamp(initHour, 0, 23));
  const [minuteIdx, setMinuteIdx] = useState(clamp(initMinute, 0, 59));
  const [hourTouched, setHourTouched] = useState(Boolean(parsed));
  const [minuteTouched, setMinuteTouched] = useState(Boolean(parsed));

  const allTouched = hourTouched && minuteTouched;
  const startRadius = isRtl ? '0 8px 8px 0' : '8px 0 0 8px';
  const endRadius = isRtl ? '8px 0 0 8px' : '0 8px 8px 0';

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 480,
        margin: '0 auto',
        // Locked to exactly one screen — dvh only (never vh, which ignores the
        // mobile browser chrome). Everything below is dvh-scaled to fit inside.
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT_SANS,
        color: INK,
      }}
    >
      <style>{`
        .wheelScroll::-webkit-scrollbar { display: none; }
        .timeWheelContinueArrow { transform: rotate(180deg); }
        [dir='rtl'] .timeWheelContinueArrow { transform: none; }
      `}</style>

      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      <div
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          // 'safe center' keeps the block centered normally but falls back to
          // start-aligned if it ever overflows, so nothing is clipped past the
          // top edge of the emergency scroller below.
          justifyContent: 'safe center',
          // Emergency fallback only (landscape phones / extreme translations):
          // the dvh clamps are sized so this never triggers in portrait.
          overflowY: 'auto',
          overflowX: 'hidden',
          gap: 'clamp(12px, 5dvh, 40px)',
          padding: 'clamp(6px, 2dvh, 16px) 20px clamp(8px, 3dvh, 24px)',
        }}
      >
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'clamp(6px, 1.75dvh, 14px)',
            padding: '0 4px',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: FONT_SERIF,
              fontWeight: 400,
              fontSize: 'clamp(18px, min(5.4vw, 3.3dvh), 25px)',
              lineHeight: 1.13,
              color: INK,
              textAlign: 'center',
            }}
          >
            {t(step.question)}
          </h2>
          {step.subtitle && (
            <p
              style={{
                margin: 0,
                fontSize: 'clamp(12px, 1.75dvh, 14px)',
                fontWeight: 300,
                lineHeight: 1.5,
                color: MUTED,
                textAlign: 'center',
              }}
            >
              {t(step.subtitle)}
            </p>
          )}
        </div>

        {/* The wheel keeps its fixed 200px height on purpose: WheelColumn's
            scroll-snap math is driven by the JS px constants ITEM_H/COL_H, so
            scaling it in CSS would desync the selected index. */}
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'stretch', justifyContent: 'center', width: '100%', maxWidth: 320 }}>
          <WheelColumn
            items={hours}
            index={hourIdx}
            onChange={setHourIdx}
            onTouch={() => setHourTouched(true)}
            touched={hourTouched}
            placeholder={t('ui.timePicker.hour')}
            width={160}
            radius={startRadius}
            ariaLabel={t('ui.timePicker.hour')}
          />
          <WheelColumn
            items={minutes}
            index={minuteIdx}
            onChange={setMinuteIdx}
            onTouch={() => setMinuteTouched(true)}
            touched={minuteTouched}
            placeholder={t('ui.timePicker.minute')}
            width={160}
            radius={endRadius}
            ariaLabel={t('ui.timePicker.minute')}
          />
        </div>
      </div>

      {/* Continue */}
      <div style={{ flex: '0 0 auto', padding: 'clamp(4px, 1dvh, 8px) 50px clamp(8px, 3dvh, 24px)' }}>
        <button
          type="button"
          disabled={!allTouched}
          onClick={() => {
            if (!allTouched) return;
            onContinue(step.nextStepId, step.storeAs, { hour: hourIdx, minute: minuteIdx });
          }}
          className="tap"
          style={{
            width: '100%',
            display: 'flex',
            gap: 15,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'clamp(9px, 1.7dvh, 13px) 20px',
            // Never drops below the 44px minimum tap target.
            minHeight: 'clamp(44px, 6.4dvh, 52px)',
            boxSizing: 'border-box',
            borderRadius: 100,
            border: '2px solid rgba(185,135,251,0.59)',
            background: 'linear-gradient(202deg, #4f397e 16%, #704ebf 49%, #402b6f 85%)',
            cursor: allTouched ? 'pointer' : 'default',
            opacity: allTouched ? 1 : 0.45,
            fontFamily: 'inherit',
            transition: 'opacity .2s ease',
          }}
        >
          <span style={{ fontSize: 'clamp(13px, 1.9dvh, 15px)', fontWeight: 600, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.45px' }}>
            {t(step.buttonLabel)}
          </span>
          <svg className="timeWheelContinueArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M16 7.83333L0.5 7.83333C1.29667 7.83333 2.28667 7.35417 3.10333 6.855C4.1925 6.18917 5.1425 5.31667 5.9375 4.31667C6.55583 3.54167 7.16667 2.61833 7.16667 2M0.5 7.83333C1.29667 7.83333 2.2875 8.3125 3.10333 8.81167C4.1925 9.47833 5.1425 10.3508 5.9375 11.3492C6.55583 12.125 7.16667 13.05 7.16667 13.6667"
              stroke="#ffffff"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
