import { describe, expect, it } from 'vitest';
import {
  barWidthPct,
  deviceLabel,
  dropSeverity,
  formatChange,
  formatDuration,
  formatPct,
  formatPeople,
  formatWait,
  isSmallSample,
  languageName,
  rankByLoss,
  severityLabel,
} from './presentation';

describe('dropSeverity', () => {
  it('bands at the exact thresholds', () => {
    // Pinned because these same numbers drive the row tint AND the badge text.
    // If they drift apart a row goes red while its badge says it is fine.
    expect(dropSeverity(9.9)).toBe('normal');
    expect(dropSeverity(10)).toBe('notable');
    expect(dropSeverity(24.9)).toBe('notable');
    expect(dropSeverity(25)).toBe('heavy');
    expect(dropSeverity(100)).toBe('heavy');
  });

  it('treats zero as normal', () => {
    expect(dropSeverity(0)).toBe('normal');
  });

  it('gives worded badges, so colour is never the only signal', () => {
    expect(severityLabel('heavy')).toBe('Most people leave here');
    expect(severityLabel('notable')).toBe('Noticeable drop');
    expect(severityLabel('normal')).toBeNull();
  });
});

describe('formatPeople', () => {
  it('groups thousands', () => {
    expect(formatPeople(1204)).toBe('1,204');
    expect(formatPeople(1_204_000)).toBe('1,204,000');
    expect(formatPeople(7)).toBe('7');
  });

  it('never renders a negative headcount', () => {
    expect(formatPeople(-5)).toBe('0');
  });
});

describe('formatPct', () => {
  it('rounds to whole numbers', () => {
    // A decimal implies precision these sample sizes rarely support.
    expect(formatPct(40.25)).toBe('40%');
    expect(formatPct(66.7)).toBe('67%');
    expect(formatPct(0)).toBe('0%');
  });
});

describe('languageName', () => {
  it('turns codes into names a non-technical reader recognises', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('lt')).toBe('Lithuanian');
    // The regional code is the one people are least likely to decode.
    expect(languageName('zh-TW')).toContain('Chinese');
  });

  it('falls back to the raw code instead of throwing', () => {
    // Retired or malformed locales sit in historical rows. The Segments screen
    // must not go down because of one.
    expect(languageName('xx-nonsense-9')).toBe('xx-nonsense-9');
    expect(languageName(null)).toBe('Unknown');
    expect(languageName(undefined)).toBe('Unknown');
    expect(languageName('')).toBe('Unknown');
  });
});

describe('deviceLabel', () => {
  it('names the device class', () => {
    expect(deviceLabel('mobile')).toBe('Mobile');
    expect(deviceLabel('desktop')).toBe('Desktop');
  });

  it('names the absence of one rather than showing a blank', () => {
    // null means the request carried no User-Agent; the rollup stores 'unknown'.
    expect(deviceLabel(null)).toBe('Unknown device');
    expect(deviceLabel('unknown')).toBe('Unknown device');
  });
});

describe('barWidthPct', () => {
  it('scales against the largest value', () => {
    expect(barWidthPct(50, 100)).toBe(50);
    expect(barWidthPct(100, 100)).toBe(100);
  });

  it('clamps so CSS can never receive a silly width', () => {
    expect(barWidthPct(150, 100)).toBe(100);
    expect(barWidthPct(-10, 100)).toBe(0);
  });

  it('returns 0 rather than NaN or Infinity on a degenerate max', () => {
    // An empty window makes max 0, and `width: NaN%` silently renders full-width.
    expect(barWidthPct(5, 0)).toBe(0);
    expect(barWidthPct(Number.NaN, 100)).toBe(0);
    expect(barWidthPct(5, Number.NaN)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats across the ranges a question actually takes', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  it('shows an em dash when nothing was measured', () => {
    // Not "0s" — that would claim the question was answered instantly.
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatWait', () => {
  it('reads as a waiting time', () => {
    expect(formatWait(41)).toBe('41s');
    expect(formatWait(221)).toBe('3m 41s');
    expect(formatWait(null)).toBe('—');
  });
});

describe('formatChange', () => {
  it('uses a true minus sign, not a hyphen', () => {
    // At small sizes a hyphen beside a digit reads as part of the number.
    expect(formatChange(-288)).toBe('−288');
    expect(formatChange(-1204)).toBe('−1,204');
  });

  it('renders nothing for no change', () => {
    expect(formatChange(0)).toBe('');
  });

  it('marks a gain explicitly', () => {
    // Rare but real: a companion screen can be reached by more people than the
    // question before it once branches rejoin.
    expect(formatChange(12)).toBe('+12');
  });
});

describe('rankByLoss', () => {
  const rows = [
    { id: 'one-of-four', dropPct: 25, dropped: 1 },
    { id: 'three-of-seventeen', dropPct: 18, dropped: 3 },
    { id: 'quiet', dropPct: 4, dropped: 1 },
  ];

  it('ranks by PEOPLE while the sample is small', () => {
    // The defect this exists to prevent: 1-of-4 scores a higher percentage than
    // 3-of-17, so a percentage ranking would put a question that lost one person
    // at the top of "biggest losses" and send someone off to fix nothing.
    expect(rankByLoss(rows, 17).map((r) => r.id)).toEqual([
      'three-of-seventeen',
      'one-of-four',
      'quiet',
    ]);
  });

  it('ranks by percentage once there is enough traffic to trust one', () => {
    expect(rankByLoss(rows, 500).map((r) => r.id)).toEqual([
      'one-of-four',
      'three-of-seventeen',
      'quiet',
    ]);
  });

  it('switches exactly at the threshold', () => {
    expect(isSmallSample(29)).toBe(true);
    expect(isSmallSample(30)).toBe(false);
    expect(rankByLoss(rows, 30)[0]!.id).toBe('one-of-four');
    expect(rankByLoss(rows, 29)[0]!.id).toBe('three-of-seventeen');
  });

  it('does not mutate the input', () => {
    const original = [...rows];
    rankByLoss(rows, 17);
    expect(rows).toEqual(original);
  });
});
