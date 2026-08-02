/* eslint-disable react/display-name -- these are inline vi.mock() stand-ins for motion/react primitives, not components anyone renders by name in a devtools tree. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { forwardRef } from 'react';

// OfferPage render tree: LandingNav + OfferTrialPricePicker (4 price pills).
//
// No inline checkout and no modal are mounted here — the picker's Continue CTA
// does a router.push to /offer/details, which is where the checkout lives. The
// assertion that no payment intent is created on this page is load-bearing:
// mounting a checkout on /offer would open an order for every visitor.

// ─── motion/react mock  -  strip animation props ───────────────────────────
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
    button: forwardRef(
      (
        { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
        _ref: React.Ref<HTMLButtonElement>,
      ) => {
        const {
          initial: _i,
          animate: _a,
          exit: _e,
          transition: _t,
          variants: _v,
          whileHover: _wh,
          whileTap: _wt,
          ...validProps
        } = props;
        return (
          <button {...(validProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
            {children}
          </button>
        );
      },
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  useReducedMotion: () => false,
  useInView: () => true,
}));

// ─── next/image mock ───────────────────────────────────────────────────────
vi.mock('next/image', () => ({
  default: (
    props: React.ImgHTMLAttributes<HTMLImageElement> & {
      fill?: boolean;
      priority?: boolean;
      sizes?: string;
    },
  ) => {
    // eslint-disable-next-line @next/next/no-img-element
    const { fill: _f, priority: _p, sizes: _s, ...rest } = props;
    return <img {...rest} alt={props.alt ?? ''} />;
  },
}));

// ─── navigation mocks ──────────────────────────────────────────────────────
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

const mockFetch = vi.fn();

// ─── analytics mock ────────────────────────────────────────────────────────
const mockTrack = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

// ─── funnel store mock ─────────────────────────────────────────────────────
const mockSetStage = vi.fn();
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (s: { setStage: typeof mockSetStage }) => unknown) =>
    selector({ setStage: mockSetStage }),
}));

// ─── quiz hydration hook  -  return true so the gate unblocks in tests ─────
vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({
  useQuizHydration: () => true,
}));

// ─── quiz store mock ───────────────────────────────────────────────────────
// OfferPage selects isComplete / sessionId / answers.primaryGoal. The store
// also exposes getState().grantPurchaseAuthorization for the special-offer
// pay-success path.
const mockQuizStoreState = {
  isComplete: false,
  sessionId: null as string | null,
  answers: {} as Record<string, string>,
};
const mockGrantPurchaseAuthorization = vi.fn();

vi.mock('@/stores/quiz-store', () => {
  const useQuizStore = (
    selector: (s: typeof mockQuizStoreState) => unknown,
  ) => selector(mockQuizStoreState);
  useQuizStore.getState = () => ({
    ...mockQuizStoreState,
    grantPurchaseAuthorization: mockGrantPurchaseAuthorization,
  });
  return { useQuizStore };
});

// A checkout mounted here would be a bug; stub it so its absence is assertable.
vi.mock('@/components/checkout', () => ({
  UnifiedCheckout: () => <div data-testid="unified-checkout" />,
}));

import { NextIntlClientProvider } from 'next-intl';
import enOffer from '@repo/i18n/messages/en/offer.json';
import enCommon from '@repo/i18n/messages/en/common.json';
import { OfferPage } from '../components/offer-page';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intlMessages = { offer: enOffer, common: enCommon } as any;
const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('OfferPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mockQuizStoreState.isComplete = false;
    mockQuizStoreState.sessionId = null;
    mockQuizStoreState.answers = {};
    window.history.replaceState({}, '', '/offer');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /quiz when the quiz is not complete', () => {
    mockQuizStoreState.isComplete = false;
    mockQuizStoreState.sessionId = null;
    renderWithIntl(<OfferPage />);
    expect(mockReplace).toHaveBeenCalledWith('/quiz');
  });

  it('renders the trial price picker when the quiz is complete', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    renderWithIntl(<OfferPage />);
    // OfferTrialPricePicker headline: offer.pricePicker.headline.
    expect(screen.getByText(enOffer.pricePicker.headline)).toBeTruthy();
  });

  it('fires oto_viewed analytics with product "main" on mount', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'test-123';
    renderWithIntl(<OfferPage />);
    expect(mockTrack).toHaveBeenCalledWith('oto_viewed', {
      session_id: 'test-123',
      product: 'main',
    });
  });

  it('renders four selectable trial-price pills', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'sess_pills';
    renderWithIntl(<OfferPage />);
    // OfferTrialPricePicker renders one aria-pressed pill per trial tier.
    const pills = document.querySelectorAll('button[aria-pressed]');
    expect(pills).toHaveLength(4);
  });

  it('tracks tier_selected when a trial-price pill is clicked', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'sess_pills';
    renderWithIntl(<OfferPage />);
    const pills = document.querySelectorAll('button[aria-pressed]');
    fireEvent.click(pills[0]);
    // OfferPage.onSelect -> track('tier_selected', { product: id }) with one of
    // trial1..trial4.
    const tierCalls = mockTrack.mock.calls.filter(([event]) => event === 'tier_selected');
    expect(tierCalls).toHaveLength(1);
    expect(['trial1', 'trial2', 'trial3', 'trial4']).toContain(
      (tierCalls[0][1] as { product: string }).product,
    );
  });

  it('navigates to /offer/details with the selected tier when Continue is clicked', () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'sess_cta';
    renderWithIntl(<OfferPage />);
    fireEvent.click(screen.getByRole('button', { name: enOffer.pricePicker.cta }));
    expect(mockTrack).toHaveBeenCalledWith(
      'offer_cta_clicked',
      expect.objectContaining({ tier: expect.any(String) }),
    );
    expect(mockPush).toHaveBeenCalledWith(expect.stringMatching(/^\/offer\/details\?tier=trial4$/));
  });

  it('does not mount a checkout, and creates no payment intent, on /offer', async () => {
    mockQuizStoreState.isComplete = true;
    mockQuizStoreState.sessionId = 'sess_rfc';
    renderWithIntl(<OfferPage />);
    // The offer page no longer mounts an inline checkout; the picker routes to
    // /offer/details instead.
    await waitFor(() => {
      expect(screen.queryByTestId('unified-checkout')).toBeNull();
    });
    const orderCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0].includes('create-payment-intent') || c[0].includes('create-session')),
    );
    expect(orderCalls).toHaveLength(0);
  });

  describe('variant prop', () => {
    it('does NOT redirect to /quiz when variant="special-1eur" and the quiz is incomplete', async () => {
      mockQuizStoreState.isComplete = false;
      mockQuizStoreState.sessionId = null;

      renderWithIntl(<OfferPage variant="special-1eur" />);
      await Promise.resolve();

      expect(mockReplace).not.toHaveBeenCalledWith('/quiz');
    });

    it('STILL redirects to /quiz for the default "main" variant when incomplete', () => {
      mockQuizStoreState.isComplete = false;
      mockQuizStoreState.sessionId = null;

      renderWithIntl(<OfferPage />);

      expect(mockReplace).toHaveBeenCalledWith('/quiz');
    });

    it('renders the SpecialOfferEmailGate dialog when variant="special-1eur" before the gate passes', () => {
      mockQuizStoreState.isComplete = false;
      mockQuizStoreState.sessionId = null;

      renderWithIntl(<OfferPage variant="special-1eur" />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('renders the SpecialOfferEmailGate dialog for variant="special-free" too', () => {
      mockQuizStoreState.isComplete = false;
      mockQuizStoreState.sessionId = null;

      renderWithIntl(<OfferPage variant="special-free" />);

      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does NOT render the SpecialOfferEmailGate for the default "main" variant', () => {
      mockQuizStoreState.isComplete = true;
      mockQuizStoreState.sessionId = 'test-main';

      renderWithIntl(<OfferPage />);

      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
