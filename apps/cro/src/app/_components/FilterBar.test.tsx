import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QUIZ_VARIANT } from '@repo/shared/quiz-variant';
import { parseFilters, type DashboardSearchParams } from '@/lib/filters';
import type { SegmentOptionRow } from '@/lib/queries';
import { FilterBar } from './FilterBar';

// The period row embeds CustomRange, which pushes to the router on submit.
// Outside a Next app there is no router to mount, so the whole bar would fail
// to render over a control none of these assertions touch.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(cleanup);

const NOW = new Date('2026-09-14T11:30:00.000Z');

function option(
  kind: SegmentOptionRow['kind'],
  id: string,
  sessions = 100,
): SegmentOptionRow {
  return {
    kind,
    id,
    sessions,
    first_seen: '2026-09-01T00:00:00.000Z',
    last_seen: '2026-09-14T00:00:00.000Z',
  };
}

function renderBar(
  segments: SegmentOptionRow[],
  params: DashboardSearchParams = {},
  allowBlend = false,
) {
  return render(
    <FilterBar
      filters={parseFilters(params, NOW)}
      basePath="/dashboard"
      segments={segments}
      allowBlend={allowBlend}
    />,
  );
}

/** The chips of one labelled row, by its aria-label. */
function row(label: string) {
  return within(screen.getByRole('navigation', { name: label }));
}

describe('row suppression', () => {
  it('hides a row whose single option is already the selection', () => {
    renderBar([option('version', QUIZ_VARIANT)]);
    expect(screen.queryByRole('navigation', { name: 'Quiz' })).toBeNull();
  });

  it('KEEPS a row whose single option is not the selection', () => {
    // The case `options.length > 1` gets wrong: a freshly deployed version has
    // no rows yet, so the only option is the OLD one — and hiding the row
    // leaves no way back to the version that has the data.
    renderBar([option('version', 'previous-v0')]);
    expect(row('Quiz').getByRole('link', { name: /previous-v0/ })).toBeTruthy();
  });

  it('hides a row with no options at all', () => {
    renderBar([]);
    expect(screen.queryByRole('navigation', { name: 'Market' })).toBeNull();
  });

  it('always renders the period row, which needs no traffic to be useful', () => {
    renderBar([]);
    expect(row('Period').getByRole('link', { name: '7 days' })).toBeTruthy();
  });
});

describe('the two axes read differently', () => {
  const segments = [
    option('funnel', 'main-v1', 700),
    option('funnel', 'offer-b', 300),
    option('version', QUIZ_VARIANT, 800),
    option('version', 'boilerplate-v0', 200),
  ];

  it('offers "All" on funnels, where blending is sound', () => {
    renderBar(segments);
    expect(row('Funnel').getByRole('link', { name: /^All/ })).toBeTruthy();
  });

  it('offers no "All" on versions by default', () => {
    renderBar(segments);
    expect(row('Quiz').queryByRole('link', { name: /^All/ })).toBeNull();
  });

  it('offers "All versions" only when a tab passes allowBlend', () => {
    renderBar(segments, {}, true);
    expect(row('Quiz').getByRole('link', { name: /^All/ })).toBeTruthy();
  });

  it('marks the resting funnel selection as current without a chip being clicked', () => {
    renderBar(segments);
    expect(row('Funnel').getByRole('link', { name: /^All/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks this build’s version as current', () => {
    renderBar(segments);
    // Registered versions render their friendly label; the raw id is only
    // the fallback for one nobody added to segment-labels.ts.
    const chip = row('Quiz').getByRole('link', { name: /Boilerplate v1/ });
    expect(chip).toHaveAttribute('aria-current', 'page');
    expect(row('Quiz').getByRole('link', { name: /boilerplate-v0/ })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('links preserve the rest of the filters', () => {
  it('carries the period and market into a funnel chip', () => {
    renderBar([option('funnel', 'main-v1'), option('funnel', 'offer-b')], {
      days: '7',
      locale: 'en',
    });
    const href = row('Funnel').getByRole('link', { name: /offer-b/ }).getAttribute('href')!;
    const params = new URL(href, 'https://x.test').searchParams;
    expect(params.get('f')).toBe('offer-b');
    expect(params.get('days')).toBe('7');
    expect(params.get('locale')).toBe('en');
  });

  it('keeps v=all on a chip clicked while blending', () => {
    renderBar([option('locale', 'en'), option('locale', 'de')], { v: 'all' }, true);
    const href = row('Market').getByRole('link', { name: /^All/ }).getAttribute('href')!;
    expect(new URL(href, 'https://x.test').searchParams.get('v')).toBe('all');
  });
});
