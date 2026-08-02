/* eslint-disable react/display-name -- these are inline vi.mock() stand-ins for motion/react primitives, not components anyone renders by name in a devtools tree. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { forwardRef } from 'react';

// Mock motion/react  -  strip animation props so jsdom renders cleanly.
// ResultsStats / ResultsHero etc. use motion.section with variants.
vi.mock('motion/react', () => ({
  motion: {
    section: forwardRef(
      (
        { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
        _ref: React.Ref<HTMLElement>,
      ) => {
        const { initial: _i, animate: _a, exit: _e, transition: _t, variants: _v, ...validProps } =
          props;
        return <section {...(validProps as React.HTMLAttributes<HTMLElement>)}>{children}</section>;
      },
    ),
    div: forwardRef(
      (
        { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
        _ref: React.Ref<HTMLDivElement>,
      ) => {
        const { initial: _i, animate: _a, exit: _e, transition: _t, variants: _v, ...validProps } =
          props;
        return <div {...(validProps as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;
      },
    ),
  },
  useReducedMotion: () => false,
}));

// Mock navigation  -  ResultsPage uses @repo/i18n/navigation useRouter.
const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => '/',
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  usePathname: () => '/',
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

// Mock analytics
const mockTrack = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

// Mock funnel store
const mockSetStage = vi.fn();
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (s: { setStage: typeof mockSetStage }) => unknown) =>
    selector({ setStage: mockSetStage }),
}));

// Mock quiz store  -  overrideable per test
const mockQuizStoreState = {
  isComplete: false,
  sessionId: null as string | null,
  answers: {} as Record<string, string>,
};
vi.mock('@/stores/quiz-store', () => ({
  useQuizStore: (
    selector: (s: {
      isComplete: boolean;
      sessionId: string | null;
      answers: Record<string, string>;
    }) => unknown,
  ) => selector(mockQuizStoreState),
}));

import { NextIntlClientProvider } from 'next-intl';
import enCommon from '@repo/i18n/messages/en/common.json';
import { ResultsPage } from '../components/results-page';

// ResultsPage + ResultsStats both call useTranslations('common.results'), so a
// real provider is required for the i18n-driven nav label and CTA copy.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intlMessages = { common: enCommon } as any;
const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('ResultsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })));
    mockQuizStoreState.isComplete = false;
    mockQuizStoreState.sessionId = null;
    mockQuizStoreState.answers = {};
  });

  it('redirects to /quiz when the quiz is not complete', () => {
    mockQuizStoreState.isComplete = false;
    mockQuizStoreState.sessionId = null;
    renderWithIntl(<ResultsPage />);
    expect(mockReplace).toHaveBeenCalledWith('/quiz');
  });

  it('renders the segment hero headline for the resolved primaryGoal segment', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'health' };
    renderWithIntl(<ResultsPage />);
    // SEGMENT_CONFIGS.health.heroHeadline is rendered verbatim by ResultsHero.
    expect(screen.getByText('Your Performance-Focused Starter Path Is Ready')).toBeTruthy();
  });

  it('renders the generic stats values shared across every segment', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'health' };
    renderWithIntl(<ResultsPage />);
    // GENERIC_STATS values, passed straight into ResultsStats.
    expect(screen.getByText('Quiz')).toBeTruthy();
    expect(screen.getByText('Secure')).toBeTruthy();
    expect(screen.getByText('PWA')).toBeTruthy();
  });

  it('renders segment-specific testimonials for the self-esteem segment', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'self-esteem' };
    renderWithIntl(<ResultsPage />);
    expect(screen.getByText('Starter User A')).toBeTruthy();
  });

  it('renders the continueToOffer CTA button from the common.results namespace', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'health' };
    renderWithIntl(<ResultsPage />);
    // common.results.continueToOffer -> "Continue to Offer".
    expect(screen.getByRole('button', { name: 'Continue to Offer' })).toBeTruthy();
  });

  it('navigates to /offer when the continueToOffer CTA is clicked', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'event' };
    renderWithIntl(<ResultsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Offer' }));
    expect(mockPush).toHaveBeenCalledWith('/offer');
  });

  it('renders nothing when primaryGoal is not a known segment key', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    mockQuizStoreState.answers = { primaryGoal: 'not-a-real-segment' };
    const { container } = renderWithIntl(<ResultsPage />);
    // ResultsPage early-returns null when primaryGoal is missing from SEGMENT_CONFIGS.
    expect(container.firstChild).toBeNull();
  });

  it('fires oto_viewed analytics with the segment once the gate opens', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'sess-xyz';
    mockQuizStoreState.answers = { primaryGoal: 'emotional_eating' };
    renderWithIntl(<ResultsPage />);
    expect(mockTrack).toHaveBeenCalledWith('oto_viewed', {
      session_id: 'sess-xyz',
      segment: 'emotional_eating',
    });
  });
});
