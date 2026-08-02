'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Shared iOS-style scroll-snap wheel column, used by the date (Month/Day/Year)
// and time (Hour/Minutes) pickers. The centre slot is highlighted; items fade
// with distance from centre. "touched" is derived from real user input, not
// scroll events (programmatic scrollTop also fires scroll).

export const ITEM_H = 40;
export const VISIBLE = 5;
export const PAD = ITEM_H * 2;
export const COL_H = ITEM_H * VISIBLE;

const INK = '#0e0f23';
const MUTED = '#51536c';

export function wheelClamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export interface WheelColumnProps {
  items: string[];
  index: number;
  onChange: (i: number) => void;
  onTouch: () => void;
  touched: boolean;
  placeholder: string;
  width: number;
  radius: string;
  ariaLabel: string;
}

export function WheelColumn({ items, index, onChange, onTouch, touched, placeholder, width, radius, ariaLabel }: WheelColumnProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [live, setLive] = useState(index);

  // Keep scroll position in sync when the controlled index changes externally
  // (e.g. day clamped when the month/year changes). Avoids a feedback loop by
  // only forcing scroll when it actually diverges from the current position.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const current = Math.round(el.scrollTop / ITEM_H);
    if (current !== index) {
      el.scrollTop = index * ITEM_H;
      setLive(index);
    }
  }, [index]);

  const markTouched = useCallback(() => {
    if (!touched) onTouch();
  }, [touched, onTouch]);

  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const i = wheelClamp(Math.round(el.scrollTop / ITEM_H), 0, items.length - 1);
      setLive(i);
    });
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      const i = wheelClamp(Math.round(el.scrollTop / ITEM_H), 0, items.length - 1);
      onChange(i);
      if (Math.abs(el.scrollTop - i * ITEM_H) > 1) el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' });
    }, 140);
  }, [items.length, onChange]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);
  }, []);

  const scrollToIndex = (i: number) => {
    const el = ref.current;
    if (!el) return;
    if (!touched) onTouch();
    el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative', width, height: COL_H, background: 'rgba(255,255,255,0.3)', borderRadius: radius }}>
      {/* Centre highlight pill */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          top: PAD,
          height: ITEM_H,
          borderRadius: 8,
          background: 'radial-gradient(ellipse at center, rgba(156,135,204,0.30) 0%, rgba(98,57,192,0.32) 100%)',
          boxShadow: '0 0 6px 0 rgba(98,57,192,0.2)',
          pointerEvents: 'none',
        }}
      />
      <div
        ref={ref}
        className="wheelScroll"
        role="listbox"
        aria-label={ariaLabel}
        tabIndex={0}
        onScroll={handleScroll}
        onPointerDown={markTouched}
        onWheel={markTouched}
        onTouchStart={markTouched}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            markTouched();
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const next = wheelClamp(live + delta, 0, items.length - 1);
            ref.current?.scrollTo({ top: next * ITEM_H, behavior: 'smooth' });
          }
        }}
        style={{
          position: 'relative',
          height: '100%',
          overflowY: 'scroll',
          scrollSnapType: 'y mandatory',
          paddingTop: PAD,
          paddingBottom: PAD,
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {items.map((label, i) => {
          const dist = Math.abs(i - live);
          const isCenter = i === live;
          return (
            <div
              key={i}
              role="option"
              aria-selected={isCenter}
              onClick={() => scrollToIndex(i)}
              style={{
                height: ITEM_H,
                scrollSnapAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: isCenter ? INK : MUTED,
                fontSize: isCenter ? 16 : 14,
                fontWeight: 300,
                lineHeight: 1,
                opacity: dist >= 2 ? 0.5 : 1,
                transition: 'opacity .15s ease, color .15s ease, font-size .15s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {isCenter && !touched ? placeholder : label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
