import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// GREEN (Plan 05): ../KpiCardsRow is implemented as an async Server Component
// rendering three KpiCards (Sessions, Leads, Revenue), each with three
// fixed buckets labelled "Today", "7d", "30d" per D-12.
//
// The component imports three query modules; we mock them so the test
// stays a pure component-shape assertion (no Supabase, no env vars needed).

describe('KpiCardsRow (D-12 three-bucket KPI row)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders 3 buckets labelled Today, 7d, 30d for each KPI card', async () => {
    vi.doMock('../../../_queries/sessions', () => ({
      countSessionsInRange: vi.fn().mockResolvedValue(7),
    }));
    vi.doMock('../../../_queries/leads', () => ({
      countLeadsInRange: vi.fn().mockResolvedValue(3),
    }));
    vi.doMock('../../../_queries/revenue', () => ({
      netRevenueInEurInRange: vi.fn().mockResolvedValue(12345),
    }));

    const { KpiCardsRow } = await import('../KpiCardsRow');
    // KpiCardsRow is an async Server Component — await its JSX, then render.
    const element = await KpiCardsRow();
    render(element);

    // D-12: every KpiCard renders the three bucket captions side-by-side.
    // We expect 3 cards × 3 captions = 9 occurrences total of each label.
    expect(screen.getAllByText('Today').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('7d').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('30d').length).toBeGreaterThanOrEqual(3);

    // KPI labels (one per card) must be present.
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getByText(/Net collections/)).toBeInTheDocument();
  });
});
