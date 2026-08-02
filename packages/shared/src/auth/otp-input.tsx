'use client';

import { useRef } from 'react';

interface OtpInputProps {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function OtpInput({ value, disabled = false, onChange }: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? '');

  const focusIndex = (index: number) => {
    refs.current[index]?.focus();
    refs.current[index]?.select();
  };

  const updateDigit = (index: number, nextDigit: string) => {
    const nextDigits = [...digits];
    nextDigits[index] = nextDigit;
    onChange(nextDigits.join(''));
  };

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          aria-label={`Digit ${index + 1}`}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digits[index]}
          disabled={disabled}
          onChange={(event) => {
            const nextValue = event.target.value.replace(/\D/g, '').slice(-1);

            updateDigit(index, nextValue);

            if (nextValue && index < 5) {
              focusIndex(index + 1);
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Backspace') {
              return;
            }

            if (digits[index]) {
              updateDigit(index, '');
              return;
            }

            if (index > 0) {
              focusIndex(index - 1);
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);

            if (!pasted) {
              return;
            }

            event.preventDefault();

            const nextDigits = Array.from({ length: 6 }, (_, digitIndex) => pasted[digitIndex] ?? '');
            onChange(nextDigits.join(''));
            focusIndex(Math.min(pasted.length - 1, 5));
          }}
          // Stock Tailwind only — this component is rendered by BOTH apps, so
          // any app-defined token class here renders unstyled in the other one.
          className="h-14 w-11 rounded-lg border border-neutral-300 bg-white text-center text-2xl font-bold text-neutral-900 outline-none transition focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-60 sm:h-16 sm:w-12"
        />
      ))}
    </div>
  );
}
