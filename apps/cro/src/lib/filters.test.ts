import { describe, expect, it } from 'vitest';
import { QUIZ_VARIANT } from '@repo/shared/quiz-variant';
import {
  ALL_VERSIONS,
  MAX_WINDOW_DAYS,
  filterHref,
  isCustomRange,
  parseFilters,
  rangeLabel,
  requiredQuizVersion,
  todayIso,
  wasClamped,
  windowFloor,
} from './filters';

/** Fixed so the window maths is reproducible rather than drifting with the clock. */
const NOW = new Date('2026-09-14T11:30:00.000Z');

describe('parseFilters — periods', () => {
  it('defaults to 30 days', () => {
    const f = parseFilters({}, NOW);
    expect(f.days).toBe(30);
    expect(isCustomRange(f)).toBe(false);
  });

  it('clamps a preset to the longest window the picker offers', () => {
    expect(parseFilters({ days: '3650' }, NOW).days).toBe(MAX_WINDOW_DAYS);
  });

  it.each(['0', '-7', 'thirty', ''])('falls back rather than erroring on days=%s', (days) => {
    expect(parseFilters({ days }, NOW).days).toBe(30);
  });

  it('reads a custom window and derives its span inclusively', () => {
    const f = parseFilters({ from: '2026-09-01', to: '2026-09-07' }, NOW);
    expect(f).toMatchObject({ from: '2026-09-01', to: '2026-09-07', days: 7 });
  });

  it('rejects a date that only LOOKS valid, rather than rolling it over', () => {
    // Date('2026-02-31') is March 3. Accepting it would shift the window by
    // three days with nothing on screen to say so.
    expect(isCustomRange(parseFilters({ from: '2026-02-31', to: '2026-03-05' }, NOW))).toBe(
      false,
    );
  });

  it('clamps a start past the cap instead of rejecting the whole window', () => {
    const f = parseFilters({ from: '2020-01-01', to: '2026-09-10' }, NOW);
    expect(f.from).toBe(windowFloor(NOW));
    expect(wasClamped('2020-01-01', NOW)).toBe(true);
  });

  it('clamps an end in the future to today', () => {
    expect(parseFilters({ from: '2026-09-10', to: '2099-01-01' }, NOW).to).toBe(todayIso(NOW));
  });

  it('falls back when the window is inverted', () => {
    expect(isCustomRange(parseFilters({ from: '2026-09-10', to: '2026-09-01' }, NOW))).toBe(
      false,
    );
  });
});

describe('parseFilters — the two axes are opposites', () => {
  it('absent funnel means every funnel', () => {
    expect(parseFilters({}, NOW).funnelVariant).toBeUndefined();
  });

  it('absent version means THIS version, not every version', () => {
    expect(parseFilters({}, NOW).quizVersion).toBe(QUIZ_VARIANT);
  });

  it('only ?v=all opts into blending versions', () => {
    expect(parseFilters({ v: ALL_VERSIONS }, NOW).quizVersion).toBeUndefined();
  });

  it('honours a version this build has never heard of', () => {
    // A version outlives its registry entry, and its rows are still in the
    // table. Refusing it would make old windows unreadable.
    expect(parseFilters({ v: 'retired-v0' }, NOW).quizVersion).toBe('retired-v0');
  });

  it('falls back to this version on a malformed code', () => {
    expect(parseFilters({ v: 'oops/../etc' }, NOW).quizVersion).toBe(QUIZ_VARIANT);
  });

  it('drops a locale outside the routing set', () => {
    expect(parseFilters({ locale: 'xx' }, NOW).locale).toBeUndefined();
    expect(parseFilters({ locale: 'en' }, NOW).locale).toBe('en');
  });
});

describe('requiredQuizVersion', () => {
  it('never returns undefined, even when the URL asked to blend', () => {
    expect(requiredQuizVersion(parseFilters({ v: ALL_VERSIONS }, NOW))).toBe(QUIZ_VARIANT);
  });
});

describe('filterHref', () => {
  const base = parseFilters({}, NOW);

  it('writes nothing for the resting state', () => {
    expect(filterHref('/dashboard', base)).toBe('/dashboard');
  });

  it('writes v=all explicitly, because absent means the opposite', () => {
    expect(filterHref('/dashboard', base, { quizVersion: undefined })).toBe(
      '/dashboard?v=all',
    );
  });

  it('omits f at "all", because absent already means all funnels', () => {
    const all = filterHref('/dashboard', { ...base, funnelVariant: 'b' }, {
      funnelVariant: undefined,
    });
    expect(all).toBe('/dashboard');
  });

  it('clears a custom window when a preset is chosen', () => {
    const custom = parseFilters({ from: '2026-09-01', to: '2026-09-07' }, NOW);
    // A leftover from/to would win in parseFilters and the preset link would
    // appear to do nothing.
    expect(filterHref('/dashboard', custom, { days: 7 })).toBe('/dashboard?days=7');
  });

  it('round-trips through parseFilters', () => {
    const chosen = parseFilters({ days: '7', locale: 'en', f: 'main-v1', v: 'quiz-v9' }, NOW);
    const url = new URL(filterHref('/dashboard', chosen), 'https://x.test');
    const back = parseFilters(Object.fromEntries(url.searchParams), NOW);
    expect(back).toEqual(chosen);
  });
});

describe('rangeLabel', () => {
  it.each([
    [{ days: 30 }, 'Last 30 days'],
    [{ days: 1, from: '2026-08-03', to: '2026-08-03' }, '3 Aug 2026'],
    [{ days: 14, from: '2026-08-01', to: '2026-08-14' }, '1–14 Aug 2026'],
    // "Sept", not "Sep": CLDR gives en-GB a four-letter September and this
    // pins the real Intl output rather than what the other months suggest.
    [{ days: 40, from: '2026-07-30', to: '2026-09-07' }, '30 Jul 2026 – 7 Sept 2026'],
  ])('%o reads as %s', (filters, expected) => {
    expect(rangeLabel(filters)).toBe(expected);
  });
});
