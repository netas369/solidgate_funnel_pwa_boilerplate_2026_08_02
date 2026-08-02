'use client';

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import type { useTranslations } from 'next-intl';
import { getLocaleDir } from '@repo/i18n/routing';
import type { DateWheelStep } from '@/features/quiz/config/quiz-schema';
import { QuizNav } from './quiz-nav';
import { WheelColumn, wheelClamp as clamp } from './wheel-column';

interface DateWheelStepProps {
  step: DateWheelStep;
  t: ReturnType<typeof useTranslations>;
  initialValue: string | undefined; // ISO YYYY-MM-DD
  onContinue: (
    nextStepId: string,
    storeAs: string,
    date: { day: number; month: number; year: number },
  ) => void;
  onBack: () => void;
}

const FONT_SANS =
  "var(--font-sans), var(--font-sans), system-ui, -apple-system, sans-serif";
const FONT_SERIF = "var(--font-display), Georgia, serif";
const INK = '#0e0f23';
const MUTED = '#51536c';
type DatePart = 'day' | 'month' | 'year';

export function DateWheelStepView({ step, t, initialValue, onContinue, onBack }: DateWheelStepProps) {
  const locale = useLocale();
  const isRtl = getLocaleDir(locale) === 'rtl';

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDay = now.getDate();
  const maxYear = Math.min(step.maxYear ?? currentYear, currentYear);
  const minYear = step.minYear ?? 1920;

  // Localized full month names via Intl.
  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, [locale]);

  const years = useMemo(
    () => Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i),
    [minYear, maxYear],
  );

  const dateOrder = useMemo<DatePart[]>(() => {
    const order = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
      .formatToParts(new Date(2000, 10, 22))
      .map((part) => part.type)
      .filter((part): part is DatePart => part === 'day' || part === 'month' || part === 'year');
    return [...new Set(order)].length === 3 ? [...new Set(order)] : ['month', 'day', 'year'];
  }, [locale]);

  // Parse an initial ISO value, else sensible defaults (values around the
  // placeholder so the wheel doesn't start on an edge).
  const parsed = initialValue?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fallbackYear = clamp(2000, minYear, maxYear);
  const initialYear = clamp(parsed ? Number(parsed[1]) : fallbackYear, minYear, maxYear);
  const initialYearIdx = clamp(years.indexOf(initialYear), 0, years.length - 1);
  const initialMaxMonth = initialYear === currentYear ? currentMonth : 11;
  const initialMonthIdx = clamp(parsed ? Number(parsed[2]) - 1 : 5, 0, initialMaxMonth);
  const initialCalendarDays = new Date(initialYear, initialMonthIdx + 1, 0).getDate();
  const initialMaxDay =
    initialYear === currentYear && initialMonthIdx === currentMonth
      ? Math.min(initialCalendarDays, currentDay)
      : initialCalendarDays;
  const initialDayIdx = clamp(parsed ? Number(parsed[3]) - 1 : 14, 0, initialMaxDay - 1);

  const [monthIdx, setMonthIdx] = useState(initialMonthIdx);
  const [yearIdx, setYearIdx] = useState(initialYearIdx);
  const [dayIdx, setDayIdx] = useState(initialDayIdx);

  const [monthTouched, setMonthTouched] = useState(Boolean(parsed));
  const [dayTouched, setDayTouched] = useState(Boolean(parsed));
  const [yearTouched, setYearTouched] = useState(Boolean(parsed));

  const year = years[yearIdx];
  const maxMonthIdx = year === currentYear ? currentMonth : 11;
  const availableMonthNames = monthNames.slice(0, maxMonthIdx + 1);
  const calendarDays = new Date(year, monthIdx + 1, 0).getDate();
  const daysInMonth =
    year === currentYear && monthIdx === currentMonth
      ? Math.min(calendarDays, currentDay)
      : calendarDays;
  const dayItems = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => String(i + 1).padStart(2, '0')),
    [daysInMonth],
  );

  const handleMonthChange = (nextMonthIdx: number) => {
    const nextMonth = clamp(nextMonthIdx, 0, maxMonthIdx);
    const nextCalendarDays = new Date(year, nextMonth + 1, 0).getDate();
    const nextMaxDay =
      year === currentYear && nextMonth === currentMonth
        ? Math.min(nextCalendarDays, currentDay)
        : nextCalendarDays;
    setMonthIdx(nextMonth);
    setDayIdx((current) => clamp(current, 0, nextMaxDay - 1));
  };

  const handleYearChange = (nextYearIdx: number) => {
    const nextIndex = clamp(nextYearIdx, 0, years.length - 1);
    const nextYear = years[nextIndex];
    const nextMaxMonth = nextYear === currentYear ? currentMonth : 11;
    const nextMonth = clamp(monthIdx, 0, nextMaxMonth);
    const nextCalendarDays = new Date(nextYear, nextMonth + 1, 0).getDate();
    const nextMaxDay =
      nextYear === currentYear && nextMonth === currentMonth
        ? Math.min(nextCalendarDays, currentDay)
        : nextCalendarDays;
    setYearIdx(nextIndex);
    setMonthIdx(nextMonth);
    setDayIdx((current) => clamp(current, 0, nextMaxDay - 1));
  };

  const allTouched = monthTouched && dayTouched && yearTouched;
  const startRadius = isRtl ? '0 8px 8px 0' : '8px 0 0 8px';
  const endRadius = isRtl ? '8px 0 0 8px' : '0 8px 8px 0';

  const renderColumn = (part: DatePart, index: number) => {
    const radius = index === 0 ? startRadius : index === dateOrder.length - 1 ? endRadius : '0';
    if (part === 'month') {
      return (
        <WheelColumn
          key={part}
          items={availableMonthNames}
          index={monthIdx}
          onChange={handleMonthChange}
          onTouch={() => setMonthTouched(true)}
          touched={monthTouched}
          placeholder={t('ui.datePicker.month')}
          width={169}
          radius={radius}
          ariaLabel={t('ui.datePicker.month')}
        />
      );
    }
    if (part === 'day') {
      return (
        <WheelColumn
          key={part}
          items={dayItems}
          index={dayIdx}
          onChange={setDayIdx}
          onTouch={() => setDayTouched(true)}
          touched={dayTouched}
          placeholder={t('ui.datePicker.day')}
          width={83}
          radius={radius}
          ariaLabel={t('ui.datePicker.day')}
        />
      );
    }
    return (
      <WheelColumn
        key={part}
        items={years.map(String)}
        index={yearIdx}
        onChange={handleYearChange}
        onTouch={() => setYearTouched(true)}
        touched={yearTouched}
        placeholder={t('ui.datePicker.year')}
        width={83}
        radius={radius}
        ariaLabel={t('ui.datePicker.year')}
      />
    );
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 480,
        margin: '0 auto',
        // One screen, never scrolls: the step owns the whole viewport.
        // dvh only — 100vh would sit under mobile browser chrome.
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
        .dateWheelContinueArrow { transform: rotate(180deg); }
        [dir='rtl'] .dateWheelContinueArrow { transform: none; }
        /* The body is centred, but if it ever overflows (landscape phone /
           extreme translation) centring would clip the top out of reach —
           'safe' degrades to flex-start exactly in that case. */
        @supports (justify-content: safe center) {
          .dateWheelBody { justify-content: safe center; }
        }
      `}</style>

      <QuizNav onBack={onBack} backLabel={t('ui.back')} />

      <div
        className="dateWheelBody"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          // Emergency fallback only — the dvh clamps below are sized so this
          // never triggers in normal portrait use.
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'clamp(14px, 5.3dvh, 40px)',
          padding: 'clamp(8px, 2.1dvh, 16px) 20px clamp(10px, 3.2dvh, 24px)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(6px, 1.9dvh, 14px)', width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'clamp(6px, 1.9dvh, 14px)', padding: '0 4px' }}>
            <h2
              style={{
                margin: 0,
                fontFamily: FONT_SERIF,
                fontWeight: 400,
                // vw term keeps today's look on normal phones; the dvh cap only
                // bites on short viewports.
                fontSize: 'clamp(17px, min(5.4vw, 3.3dvh), 25px)',
                lineHeight: 1.13,
                color: INK,
                textAlign: 'center',
              }}
            >
              {t(step.question)}
            </h2>
            {step.subtitle && (
              <p style={{ margin: 0, fontSize: 'clamp(12px, 1.9dvh, 14px)', fontWeight: 300, lineHeight: 1.5, color: MUTED, textAlign: 'center' }}>
                {t(step.subtitle)}
              </p>
            )}
          </div>

          {/* Optional decorative image tiles above the wheel. */}
          {step.decorIcons && step.decorIcons.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 'clamp(8px, 1.9dvh, 14px)', padding: 'clamp(2px, 0.55dvh, 4px) 0' }}>
              {step.decorIcons.map((icon, i) => (
                <div
                  key={icon}
                  style={{
                    width: 'clamp(34px, 6.7dvh, 50px)',
                    height: 'clamp(34px, 6.7dvh, 50px)',
                    flex: '0 0 auto',
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(228deg, rgba(41,35,79,0.8) 4%, rgba(67,47,125,0.8) 47%, rgba(40,33,78,0.8) 95%)',
                    backdropFilter: 'blur(5px)',
                    WebkitBackdropFilter: 'blur(5px)',
                    transform: i % 2 === 1 ? 'translateY(9px)' : 'translateY(-3px)',
                    boxShadow: '0 4px 14px rgba(10,6,24,0.28)',
                  }}
                >
                  <img
                    src={icon}
                    alt=""
                    aria-hidden="true"
                    style={{ width: 'clamp(22px, 4.3dvh, 32px)', height: 'clamp(22px, 4.3dvh, 32px)', objectFit: 'contain' }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Wheel picker — height is fixed on purpose: WheelColumn's scroll-snap
            math is driven by the ITEM_H/COL_H constants, so the chrome around
            it scales instead of the wheel itself. */}
        <div style={{ display: 'flex', alignItems: 'stretch', justifyContent: 'center', width: '100%', maxWidth: 340, flex: '0 0 auto' }}>
          {dateOrder.map(renderColumn)}
        </div>
      </div>

      {/* Continue */}
      <div style={{ padding: 'clamp(6px, 1.1dvh, 8px) 50px clamp(10px, 3.2dvh, 24px)', flex: '0 0 auto' }}>
        <button
          type="button"
          disabled={!allTouched}
          onClick={() => {
            if (!allTouched) return;
            onContinue(step.nextStepId, step.storeAs, { day: dayIdx + 1, month: monthIdx + 1, year });
          }}
          className="tap"
          style={{
            width: '100%',
            display: 'flex',
            gap: 15,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'clamp(10px, 1.7dvh, 13px) 20px',
            minHeight: 44,
            borderRadius: 100,
            border: '2px solid rgba(185,135,251,0.59)',
            background: 'linear-gradient(202deg, #4f397e 16%, #704ebf 49%, #402b6f 85%)',
            cursor: allTouched ? 'pointer' : 'default',
            opacity: allTouched ? 1 : 0.45,
            fontFamily: 'inherit',
            transition: 'opacity .2s ease',
          }}
        >
          <span style={{ fontSize: 'clamp(13px, 2dvh, 15px)', fontWeight: 600, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.45px' }}>
            {t(step.buttonLabel)}
          </span>
          <svg className="dateWheelContinueArrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
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
