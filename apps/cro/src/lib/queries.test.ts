import { describe, expect, it } from 'vitest';
import { NotAnAnalystError } from './queries';
import { lastNDays, resolveRange } from './queries';
import { parseFilters } from './filters';

const NOW = new Date('2026-09-14T14:00:00.000Z');

describe('resolveRange — presets and custom windows are different SHAPES', () => {
  it('rolls a preset back from this instant, not from midnight', () => {
    const { from, to } = resolveRange(parseFilters({ days: '7' }, NOW));
    // Both carry a time of day, so "last 7 days" at 14:00 means 168 hours.
    expect(from).toMatch(/T\d\d:\d\d/);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(7 * 86_400_000);
  });

  it('makes a custom window whole calendar days in UTC', () => {
    const { from, to } = resolveRange(
      parseFilters({ from: '2026-08-01', to: '2026-08-14' }, NOW),
    );
    expect(from).toBe('2026-08-01T00:00:00.000Z');
    // `to` is EXCLUSIVE at the following midnight, so picking the 14th includes
    // all of it rather than stopping at whatever time the page was loaded.
    expect(to).toBe('2026-08-15T00:00:00.000Z');
  });

  it('includes the whole of a single chosen day', () => {
    const { from, to } = resolveRange(
      parseFilters({ from: '2026-08-03', to: '2026-08-03' }, NOW),
    );
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(86_400_000);
  });
});

describe('lastNDays', () => {
  it('spans exactly N days', () => {
    const { from, to } = lastNDays(30);
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(30 * 86_400_000);
  });
});

describe('NotAnAnalystError', () => {
  it('keeps a stable name, because QueryError matches on it across the RSC boundary', () => {
    // An Error crossing a server-component boundary can arrive as a plain Error
    // with the name preserved but the prototype lost, so QueryError checks both
    // `instanceof` and `.name`. Renaming the class silently turns "ask for
    // access" back into "something went wrong".
    const error = new NotAnAnalystError();
    expect(error.name).toBe('NotAnAnalystError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/not on the CRO analyst list/i);
  });
});
