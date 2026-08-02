'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { useTranslations } from 'next-intl';

const ITEM_HEIGHT = 44;
const VISIBLE_COUNT = 5;
const PICKER_HEIGHT = ITEM_HEIGHT * VISIBLE_COUNT;
const SIDE_PAD = ((VISIBLE_COUNT - 1) / 2) * ITEM_HEIGHT;

// Short month names for every locale the app ships with. Used by the
// WheelDatePicker because some locales (e.g. lt) default to numeric short
// months via Intl.DateTimeFormat, and we want consistent text across all
// browsers/runtimes.
const LOCALIZED_MONTH_NAMES: Record<string, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  cs: ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro'],
  da: ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'],
  el: ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μαΐ', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'],
  he: ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'],
  hr: ['Sij', 'Velj', 'Ožu', 'Tra', 'Svi', 'Lip', 'Srp', 'Kol', 'Ruj', 'Lis', 'Stu', 'Pro'],
  hu: ['Jan', 'Feb', 'Már', 'Ápr', 'Máj', 'Jún', 'Júl', 'Aug', 'Szept', 'Okt', 'Nov', 'Dec'],
  lt: ['Sau', 'Vas', 'Kov', 'Bal', 'Geg', 'Bir', 'Lie', 'Rugp', 'Rugs', 'Spa', 'Lap', 'Gru'],
  lv: ['Jan', 'Feb', 'Mar', 'Apr', 'Mai', 'Jūn', 'Jūl', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'],
  pl: ['Sty', 'Lut', 'Mar', 'Kwi', 'Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź', 'Lis', 'Gru'],
  ro: ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Noi', 'Dec'],
  ru: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'],
  sk: ['Jan', 'Feb', 'Mar', 'Apr', 'Máj', 'Jún', 'Júl', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'],
  'zh-TW': ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function daysInMonth(year: number, month: number): number {
  if (!year || !month) return 31;
  return new Date(year, month, 0).getDate();
}

// ─── WheelColumn ────────────────────────────────────────────────────────────
// Single scrollable column. Uses scroll-snap proximity (not mandatory) so
// flick gestures keep momentum across multiple items, then settle softly
// onto the nearest item. Each column draws its own pill highlight behind
// the centered row — independent visual "card" per column.

interface WheelColumnProps {
  items: string[];
  value: number;
  onChange: (index: number) => void;
  ariaLabel: string;
  touched: boolean;
}

function WheelColumn({
  items,
  value,
  onChange,
  ariaLabel,
  touched,
}: WheelColumnProps) {
  const ref = useRef<HTMLDivElement>(null);
  const ignoreScrollRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const [centerIndex, setCenterIndex] = useState(value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = value * ITEM_HEIGHT;
    if (Math.abs(el.scrollTop - target) < 1) {
      setCenterIndex(value);
      return;
    }
    ignoreScrollRef.current = true;
    el.scrollTop = target;
    setCenterIndex(value);
    requestAnimationFrame(() => {
      ignoreScrollRef.current = false;
    });
  }, [value]);

  const handleScroll = useCallback(() => {
    if (ignoreScrollRef.current) return;
    const el = ref.current;
    if (!el) return;
    const raw = el.scrollTop / ITEM_HEIGHT;
    const idx = Math.round(raw);
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    if (clamped !== centerIndex) setCenterIndex(clamped);

    if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      const settled = Math.round(el.scrollTop / ITEM_HEIGHT);
      const settledClamped = Math.max(0, Math.min(items.length - 1, settled));
      const targetTop = settledClamped * ITEM_HEIGHT;
      if (Math.abs(el.scrollTop - targetTop) > 1) {
        el.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
      onChange(settledClamped);
    }, 160);
  }, [items.length, centerIndex, onChange]);

  useEffect(
    () => () => {
      if (settleTimerRef.current) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const scrollToIndex = useCallback((i: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: i * ITEM_HEIGHT, behavior: 'smooth' });
  }, []);

  return (
    <div style={{ position: 'relative', height: PICKER_HEIGHT }}>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: SIDE_PAD,
          left: 0,
          right: 0,
          height: ITEM_HEIGHT,
          borderRadius: 999,
          background: touched ? 'rgba(17,17,17,0.05)' : 'transparent',
          border: touched
            ? '1px solid rgba(17,17,17,0.18)'
            : '1px solid rgba(17,17,17,0.08)',
          pointerEvents: 'none',
          transition: 'background 120ms linear, border-color 120ms linear',
        }}
      />
      <div
        ref={ref}
        role="listbox"
        aria-label={ariaLabel}
        onScroll={handleScroll}
        style={{
          height: PICKER_HEIGHT,
          overflowY: 'scroll',
          scrollSnapType: 'y proximity',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          position: 'relative',
          touchAction: 'pan-y',
          overscrollBehavior: 'contain',
        }}
        className="wheel-col-scroll"
      >
        <div style={{ paddingTop: SIDE_PAD, paddingBottom: SIDE_PAD }}>
          {items.map((item, i) => {
            const dist = Math.abs(i - centerIndex);
            const isCenter = i === centerIndex;
            let opacity: number;
            if (dist === 0) opacity = touched ? 1 : 0.6;
            else if (dist === 1) opacity = 0.4;
            else if (dist === 2) opacity = 0.2;
            else opacity = 0.08;

            return (
              <div
                key={i}
                role="option"
                aria-selected={isCenter}
                onClick={() => scrollToIndex(i)}
                style={{
                  height: ITEM_HEIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  scrollSnapAlign: 'center',
                  fontSize: isCenter ? 18 : 16,
                  fontWeight: isCenter && touched ? 600 : 400,
                  color: 'var(--ink)',
                  opacity,
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontVariantNumeric: 'tabular-nums',
                  transition:
                    'opacity 100ms linear, font-size 100ms linear, font-weight 100ms linear',
                  whiteSpace: 'nowrap',
                  padding: '0 6px',
                }}
              >
                {item}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── WheelDatePicker ────────────────────────────────────────────────────────

interface WheelDatePickerProps {
  value: string;
  onChange: (iso: string) => void;
  locale: string;
  label?: string;
  error?: string;
  t: ReturnType<typeof useTranslations>;
}

export function WheelDatePicker({
  value,
  onChange,
  locale,
  label,
  error,
  t,
}: WheelDatePickerProps) {
  const monthNames = useMemo(() => {
    const localized = LOCALIZED_MONTH_NAMES[locale] ?? LOCALIZED_MONTH_NAMES[locale.split('-')[0]];
    if (localized) return localized;
    const fmt = new Intl.DateTimeFormat(locale, { month: 'short' });
    return Array.from({ length: 12 }, (_, i) => {
      const name = fmt.format(new Date(2000, i, 1));
      // If Intl falls back to numeric (e.g. lt: "01"), use the en list instead.
      return /^\d+$/.test(name)
        ? LOCALIZED_MONTH_NAMES.en[i]
        : name.charAt(0).toUpperCase() + name.slice(1);
    });
  }, [locale]);

  const now = new Date();
  const maxYear = now.getFullYear() - 14;
  const minYear = now.getFullYear() - 120;
  const years = useMemo(
    () => Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i),
    [minYear, maxYear],
  );

  const defaultMonth = 5;
  const defaultDay = 14;
  const defaultYear = Math.min(
    years.length - 1,
    Math.max(0, years.indexOf(now.getFullYear() - 30)),
  );

  const parsed = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    return {
      year: parseInt(m[1], 10),
      month: parseInt(m[2], 10),
      day: parseInt(m[3], 10),
    };
  }, [value]);

  const [touchedMonth, setTouchedMonth] = useState(!!parsed);
  const [touchedDay, setTouchedDay] = useState(!!parsed);
  const [touchedYear, setTouchedYear] = useState(!!parsed);

  const [monthIdx, setMonthIdx] = useState(
    parsed ? parsed.month - 1 : defaultMonth,
  );
  const [yearIdx, setYearIdx] = useState(() => {
    if (!parsed) return defaultYear;
    const i = years.indexOf(parsed.year);
    return i >= 0 ? i : defaultYear;
  });

  const currentYear = years[yearIdx];
  const currentMonth = monthIdx + 1;
  const maxDays = daysInMonth(currentYear, currentMonth);
  const days = useMemo(
    () => Array.from({ length: maxDays }, (_, i) => String(i + 1)),
    [maxDays],
  );

  const [dayIdx, setDayIdx] = useState(parsed ? parsed.day - 1 : defaultDay);

  useEffect(() => {
    if (dayIdx >= maxDays) setDayIdx(maxDays - 1);
  }, [maxDays, dayIdx]);

  const emit = useCallback(
    (m: number, d: number, y: number, tm: boolean, ty: boolean) => {
      // The birthday counts as "set" once the visitor engages either the month
      // OR the year wheel — the day keeps its default. This unblocks Continue
      // without forcing people to scroll all three columns.
      if (tm || ty) {
        const yy = years[y];
        const mm = m + 1;
        const ddays = daysInMonth(yy, mm);
        const dd = Math.min(d + 1, ddays);
        onChange(`${yy}-${pad2(mm)}-${pad2(dd)}`);
      } else {
        onChange('');
      }
    },
    [onChange, years],
  );

  const handleMonth = useCallback(
    (i: number) => {
      setMonthIdx(i);
      setTouchedMonth(true);
      emit(i, dayIdx, yearIdx, true, touchedYear);
    },
    [dayIdx, yearIdx, touchedYear, emit],
  );
  const handleDay = useCallback(
    (i: number) => {
      setDayIdx(i);
      setTouchedDay(true);
      emit(monthIdx, i, yearIdx, touchedMonth, touchedYear);
    },
    [monthIdx, yearIdx, touchedMonth, touchedYear, emit],
  );
  const handleYear = useCallback(
    (i: number) => {
      setYearIdx(i);
      setTouchedYear(true);
      emit(monthIdx, dayIdx, i, touchedMonth, true);
    },
    [monthIdx, dayIdx, touchedMonth, emit],
  );

  const yearItems = useMemo(() => years.map((y) => String(y)), [years]);

  return (
    <div>
      {label && (
        <span
          className="mono-up"
          style={{
            display: 'block',
            marginBottom: 12,
            color: '#b58430',
            fontWeight: 700,
            textAlign: 'center',
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          maxWidth: 440,
          margin: '0 auto',
          padding: '14px 14px',
          borderRadius: 20,
          background: 'var(--paper-soft, #fafaf7)',
          border: `1px solid ${error ? 'var(--ink)' : 'var(--hairline-strong)'}`,
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr 1.2fr',
            columnGap: 14,
          }}
        >
          <WheelColumn
            items={monthNames}
            value={monthIdx}
            onChange={handleMonth}
            ariaLabel={t('ui.datePicker.month')}
            touched={touchedMonth}
          />
          <WheelColumn
            items={days}
            value={dayIdx}
            onChange={handleDay}
            ariaLabel={t('ui.datePicker.day')}
            touched={touchedDay}
          />
          <WheelColumn
            items={yearItems}
            value={yearIdx}
            onChange={handleYear}
            ariaLabel={t('ui.datePicker.year')}
            touched={touchedYear}
          />
        </div>
      </div>
      {error && (
        <span
          className="serif-it"
          style={{
            display: 'block',
            fontSize: 13,
            marginTop: 8,
            opacity: 0.75,
            color: 'var(--ink)',
            textAlign: 'center',
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

// ─── WheelTimePicker ────────────────────────────────────────────────────────

interface WheelTimePickerProps {
  value: string;
  onChange: (time: string) => void;
  label?: string;
  error?: string;
  t: ReturnType<typeof useTranslations>;
}

export function WheelTimePicker({
  value,
  onChange,
  label,
  error,
  t,
}: WheelTimePickerProps) {
  const hours = useMemo(
    () => Array.from({ length: 24 }, (_, i) => pad2(i)),
    [],
  );
  const minutes = useMemo(
    () => Array.from({ length: 60 }, (_, i) => pad2(i)),
    [],
  );

  const parsed = useMemo(() => {
    const m = /^(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  }, [value]);

  const [touchedHour, setTouchedHour] = useState(!!parsed);
  const [touchedMinute, setTouchedMinute] = useState(!!parsed);
  const [hourIdx, setHourIdx] = useState(parsed ? parsed.h : 12);
  const [minuteIdx, setMinuteIdx] = useState(parsed ? parsed.m : 0);

  // Emit the time as soon as the user engages either wheel — hour OR minute.
  // Many people only know their birth time approximately; touching one column
  // is enough of a signal, so we don't force both to be scrolled.
  const emit = useCallback(
    (h: number, m: number, th: boolean, tmin: boolean) => {
      if (th || tmin) onChange(`${pad2(h)}:${pad2(m)}`);
      else onChange('');
    },
    [onChange],
  );

  const handleHour = useCallback(
    (i: number) => {
      setHourIdx(i);
      setTouchedHour(true);
      emit(i, minuteIdx, true, touchedMinute);
    },
    [minuteIdx, touchedMinute, emit],
  );
  const handleMinute = useCallback(
    (i: number) => {
      setMinuteIdx(i);
      setTouchedMinute(true);
      emit(hourIdx, i, touchedHour, true);
    },
    [hourIdx, touchedHour, emit],
  );

  return (
    <div>
      {label && (
        <span
          className="mono-up"
          style={{
            display: 'block',
            marginBottom: 12,
            color: '#b58430',
            fontWeight: 700,
            textAlign: 'center',
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          maxWidth: 320,
          margin: '0 auto',
          padding: '14px 14px',
          borderRadius: 20,
          background: 'var(--paper-soft, #fafaf7)',
          border: `1px solid ${error ? 'var(--ink)' : 'var(--hairline-strong)'}`,
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            columnGap: 14,
          }}
        >
          <WheelColumn
            items={hours}
            value={hourIdx}
            onChange={handleHour}
            ariaLabel={t('ui.timePicker.hour')}
            touched={touchedHour}
          />
          <WheelColumn
            items={minutes}
            value={minuteIdx}
            onChange={handleMinute}
            ariaLabel={t('ui.timePicker.minute')}
            touched={touchedMinute}
          />
        </div>
      </div>
      {error && (
        <span
          className="serif-it"
          style={{
            display: 'block',
            fontSize: 13,
            marginTop: 8,
            opacity: 0.75,
            color: 'var(--ink)',
            textAlign: 'center',
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
