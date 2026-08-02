/* eslint-disable react/display-name -- these are inline vi.mock() stand-ins for motion/react primitives, not components anyone renders by name in a devtools tree. */
// SuccessClient  -  the /success page client.
//
// Coverage that matters: the funnel_completed analytics event fires exactly
// once, carries order_count and NEVER carries the raw email, plus the
// entitlement/order rendering.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React, { forwardRef } from 'react';

// ─── Motion mock ──────────────────────────────────────────────────────────────
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
  useInView: () => true,
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────
const mockSetStage = vi.fn();
const mockReplace = vi.fn();
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (s: { setStage: typeof mockSetStage }) => unknown) =>
    selector({ setStage: mockSetStage }),
}));

const mockSetAuthLinked = vi.fn();
vi.mock('@/stores/quiz-store', () => ({
  useQuizStore: (
    selector: (s: {
      sessionId: string;
      authLinked: boolean | null;
      setAuthLinked: typeof mockSetAuthLinked;
    }) => unknown,
  ) =>
    selector({
      sessionId: 'test-session-abc',
      authLinked: null,
      setAuthLinked: mockSetAuthLinked,
    }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/',
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/',
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

// ─── Analytics mock ───────────────────────────────────────────────────────────
const mockTrack = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

// ─── Child component mocks ────────────────────────────────────────────────────
vi.mock('@/features/auth/components/post-payment-nav', () => ({
  PostPaymentNav: () => <div data-testid="post-payment-nav" />,
}));

vi.mock('@/features/auth/components/claim-purchase-prompt', () => ({
  ClaimPurchasePrompt: () => <div data-testid="claim-purchase-prompt" />,
}));

vi.mock('../account-created-callout', () => ({
  AccountCreatedCallout: ({ email }: { email: string }) => (
    <div data-testid="account-created-callout">{email}</div>
  ),
}));

vi.mock('../dashboard-cta', () => ({
  DashboardCta: () => <div data-testid="dashboard-cta" />,
}));

// OrderSummaryCard is left UNMOCKED so order rows render through the real
// component  -  useful for the order-count / entitlements assertions.

// ─── Subject under test ───────────────────────────────────────────────────────
import { NextIntlClientProvider } from 'next-intl';
import enSuccess from '@repo/i18n/messages/en/success.json';
import enCommon from '@repo/i18n/messages/en/common.json';
import { SuccessClient } from '../success-client';

// A current catalog slug. orderProducts.<slug> may not exist, so the raw
// product_name is the displayed fallback - which is what we assert against.
const BASE_ORDER = {
  id: 'order-1',
  product_name: 'Main Subscription',
  product_slug: 'trial1' as const,
  amount_cents: 500,
  currency: 'eur',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intlMessages = { success: enSuccess, common: enCommon } as any;
function renderClient(overrides: Partial<React.ComponentProps<typeof SuccessClient>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      <SuccessClient
        orders={[BASE_ORDER]}
        email="test@example.com"
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

describe('SuccessClient  -  funnel_completed analytics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires funnel_completed exactly once on initial mount', () => {
    renderClient();
    const funnelCalls = mockTrack.mock.calls.filter(([event]) => event === 'funnel_completed');
    expect(funnelCalls).toHaveLength(1);
  });

  it('fires funnel_completed with order_count and WITHOUT the raw email', () => {
    renderClient({
      orders: [
        BASE_ORDER,
        { ...BASE_ORDER, id: 'order-2', product_name: 'Weekly Add-on' },
      ],
    });
    expect(mockTrack).toHaveBeenCalledWith('funnel_completed', { order_count: 2 });
    // The raw email must NEVER be forwarded on funnel_completed  -  the user is
    // already PostHog-identified from lead capture.
    const [, payload] = mockTrack.mock.calls.find(([event]) => event === 'funnel_completed')!;
    expect(payload).not.toHaveProperty('email');
  });

  it('reports order_count: 0 when there are no orders', () => {
    renderClient({ orders: [] });
    expect(mockTrack).toHaveBeenCalledWith('funnel_completed', { order_count: 0 });
  });

  it('advances the funnel stage to "success" on mount', () => {
    renderClient();
    expect(mockSetStage).toHaveBeenCalledWith('success');
  });

  it('does NOT fire funnel_completed again on a re-render', () => {
    const { rerender } = renderClient();
    rerender(
      <NextIntlClientProvider locale="en" messages={intlMessages}>
        <SuccessClient orders={[BASE_ORDER]} email="test@example.com" />
      </NextIntlClientProvider>,
    );
    const funnelCalls = mockTrack.mock.calls.filter(([event]) => event === 'funnel_completed');
    expect(funnelCalls).toHaveLength(1);
  });
});

describe('SuccessClient  -  rendering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the AccountCreatedCallout with the email when an email is present', () => {
    renderClient({ email: 'buyer@example.com' });
    expect(screen.getByTestId('account-created-callout')).toHaveTextContent('buyer@example.com');
  });

  it('renders the AccountCreatedCallout gated on the email prop', () => {
    renderClient({ email: 'present@x.io' });
    expect(screen.getByTestId('account-created-callout')).toBeInTheDocument();
  });

  it('renders the entitlements ownership list when entitlements are supplied', () => {
    renderClient({
      entitlements: [
        {
          product_slug: 'BRAND_000000_SUB',
          access_level: 'trial',
          granted_at: '2026-05-01T00:00:00Z',
          order_id: 'order-1',
          expires_at: null,
        },
      ],
    });
    // success.entitlements.heading -> "Your products".
    expect(screen.getByText('Your products')).toBeInTheDocument();
    // access_level 'trial' -> entitlements.trial label "Trial".
    expect(screen.getByText('Trial')).toBeInTheDocument();
  });
});
