import type { CSSProperties } from 'react';

// Swap this one word to compare the two quiz option looks side-by-side:
//   'filled-card'  → soft paper-toned card (recommended, more button-like)
//   'outline-card' → transparent card with hairline border (airier)
export const OPTION_CARD_STYLE: 'filled-card' | 'outline-card' = 'filled-card';

export const OPTION_CARD_GAP = 10;

export function getOptionRowStyle({
  isActive,
  isLast,
}: {
  isActive: boolean;
  isLast: boolean;
}): CSSProperties {
  const idleBg = OPTION_CARD_STYLE === 'filled-card' ? 'var(--paper-soft)' : 'transparent';
  return {
    width: '100%',
    background: isActive ? 'var(--accent)' : idleBg,
    color: isActive ? 'var(--accent-ink)' : 'var(--ink)',
    border: `1px solid ${isActive ? 'var(--ink)' : 'var(--hairline-strong)'}`,
    borderRadius: 14,
    padding: '18px 20px',
    marginBottom: isLast ? 0 : OPTION_CARD_GAP,
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    transition: 'background .2s ease, color .2s ease, border-color .2s ease',
    position: 'relative',
  };
}
