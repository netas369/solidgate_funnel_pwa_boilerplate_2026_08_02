// The ?sg_order return path — a 3DS issuer that full-page-redirects sends the
// buyer back to the page that sold to them with the order id in the URL.
//
// Contracts asserted against the CURRENT component:
//   NO QUIZ BOUNCE  -  while a valid sg_order grant is in flight, the main
//                      variant must NOT redirect to /offer even though the quiz
//                      store is empty (special buyers have no quiz; a 3DS
//                      round-trip can lose localStorage).
//   OTO AUTHORIZATION  -  a confirmed grant calls grantPurchaseAuthorization
//                      with the session parsed from the order id, so the /oto/*
//                      guards (sessionId + authorizedViaPurchase) pass.
//   RESUME  -  the buyer is routed to the grant's resumeTo (default /oto/1).
//   GATE SUPPRESSION  -  the special email gate stays hidden during the grant
//                      and reappears only when the grant fails.
//   FAILURE RECOVERY  -  a failed grant restores normal behavior: main variant
//                      bounces to /offer, special variant re-shows the gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const FREE_ORDER_ID = `${SESSION_ID}:special_free:1`;
const PAID_ORDER_ID = `${SESSION_ID}:trial3:1`;

// A SEEDED PSP catalog. `catalog-ids.json` ships EMPTY in the boilerplate, and
// an empty catalog makes checkoutProductContext() return null — a real guarded
// failure path, but not the one these tests are about.
vi.mock('@repo/shared/solidgate/catalog-ids.json', () => {
  const currencies = ['eur', 'usd', 'czk', 'huf', 'ron', 'twd', 'ils', 'pln', 'dkk', 'jpy'];
  const keys = [
    'trial1', 'trial2', 'trial3', 'trial4',
    'special_1eur', 'special_free', 'addon_trial', 'addon_direct',
  ];
  return {
    default: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          product_id: `prod_${key}`,
          prices: Object.fromEntries(currencies.map((c) => [c, `price_${key}_${c}`])),
        },
      ]),
    ),
  };
});

// ─── URL search params (controlled per test) ────────────────────────────────
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

// ─── i18n / navigation mocks ────────────────────────────────────────────────
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

const routerReplace = vi.fn();
const routerPush = vi.fn();
vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ replace: routerReplace, push: routerPush }),
}));

// ─── heavy children stubbed to markers ─────────────────────────────────────
vi.mock('../offer-sales-body', () => ({
  OfferSalesBody: () => <div data-testid="offer-body" />,
}));
vi.mock('../offer-checkout-modal', () => ({
  OfferCheckoutModal: () => null,
}));
vi.mock('../special-offer-email-gate', () => ({
  SpecialOfferEmailGate: () => <div data-testid="email-gate" />,
}));
vi.mock('@/lib/hooks/use-scroll-to-top', () => ({ useScrollToTop: () => {} }));
vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({
  useQuizHydration: () => true,
}));

const track = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track }),
}));

// ─── the grant call itself ──────────────────────────────────────────────────
const confirmSettledGrant = vi.fn();
vi.mock('@/components/checkout/solidgate-checkout', () => ({
  confirmSettledGrant: (...args: unknown[]) => confirmSettledGrant(...args),
  GRANT_POLL_BUDGET_MS: 120_000,
}));

import {
  OfferDetailsPage,
  RETURN_GRANT_MAX_ATTEMPTS,
  RETURN_GRANT_MAX_AUTO_WAIT_MS,
  RETURN_GRANT_RETRY_DELAY_MS,
} from '../offer-details-page';
import { GRANT_POLL_BUDGET_MS } from '@/components/checkout/solidgate-checkout';
import { resolveProductPrice } from '@repo/shared/price-map';
import { useQuizStore } from '@/stores/quiz-store';

// special_free settles a small intro amount rather than a zero-amount auth,
// so the return grant reports a captured settle_ok, not an authorized trial.
function freeGrantSucceeds() {
  confirmSettledGrant.mockResolvedValue({
    ok: true,
    status: 'settle_ok',
    captured: true,
    settled: true,
    fullyCaptured: false,
    authorizedTrial: false,
    resumeTo: '/oto/1',
    subscriptionId: 'sub_123',
  });
}

function paidGrantSucceeds() {
  confirmSettledGrant.mockResolvedValue({
    ok: true,
    status: 'settle_ok',
    captured: true,
    settled: true,
    fullyCaptured: false,
    authorizedTrial: false,
    resumeTo: '/oto/1',
    subscriptionId: 'sub_paid_123',
  });
}

beforeEach(() => {
  currentSearch = '';
  routerReplace.mockReset();
  routerPush.mockReset();
  track.mockReset();
  confirmSettledGrant.mockReset();
  localStorage.clear();
  useQuizStore.getState().reset();
});

describe('OfferDetailsPage — ?sg_order 3DS return', () => {
  it('special-free return: grants, authorizes the OTO chain, resumes to /oto/1, never shows the gate', async () => {
    currentSearch = `sg_order=${encodeURIComponent(FREE_ORDER_ID)}`;
    freeGrantSucceeds();

    render(<OfferDetailsPage variant="special-free" />);

    expect(screen.queryByTestId('email-gate')).toBeNull();

    await waitFor(() => {
      expect(confirmSettledGrant).toHaveBeenCalledWith(
        FREE_ORDER_ID,
        SESSION_ID,
        // special_free resolves to the same intro amount as special_1eur.
        resolveProductPrice('special_free', 'en').amountCents,
        expect.anything(),
        expect.any(Function),
      );
      expect(routerReplace).toHaveBeenCalledWith('/oto/1');
    });

    // The /oto/* guards require sessionId + authorizedViaPurchase.
    const store = useQuizStore.getState();
    expect(store.sessionId).toBe(SESSION_ID);
    expect(store.authorizedViaPurchase).toBe(true);

    expect(screen.queryByTestId('email-gate')).toBeNull();
  });

  it('main variant with an empty quiz store does NOT bounce to /offer while the grant is in flight', async () => {
    currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
    paidGrantSucceeds();

    render(<OfferDetailsPage variant="main" />);

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith('/oto/1');
    });
    expect(routerReplace).not.toHaveBeenCalledWith('/offer');
  });

  it('paid settle_ok return emits a captured checkout event eligible for Meta Purchase', async () => {
    currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
    paidGrantSucceeds();

    render(<OfferDetailsPage variant="main" />);

    await waitFor(() => {
      expect(track).toHaveBeenCalledWith('checkout_completed', expect.objectContaining({
        order_id: PAID_ORDER_ID,
        payment_status: 'settle_ok',
        settled: true,
        authorized_trial: false,
        amount_cents: 1300,
        currency: 'USD',
        value: 13,
      }));
    });
  });

  it('paid auth_ok return enters OTO1 immediately without emitting captured revenue', async () => {
    currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
    confirmSettledGrant.mockImplementation(
      async (
        _orderId: string,
        _sessionId: string,
        _amountCents: number,
        _signal: AbortSignal,
        onAccepted: (data: Record<string, unknown>) => Promise<boolean | void>,
      ) => {
        await onAccepted({
          accepted: true,
          authorized: true,
          orderId: PAID_ORDER_ID,
          status: 'auth_ok',
          subscriptionId: 'sub_paid_123',
          resumeTo: `/oto/1?sg_main=${encodeURIComponent(PAID_ORDER_ID)}`,
        });
        return new Promise(() => {});
      },
    );

    render(<OfferDetailsPage variant="main" />);

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith(
        `/oto/1?sg_main=${encodeURIComponent(PAID_ORDER_ID)}`,
      );
    });
    expect(useQuizStore.getState()).toMatchObject({
      sessionId: SESSION_ID,
      authorizedViaPurchase: true,
    });
    expect(track).toHaveBeenCalledWith('oto_accepted', expect.objectContaining({
      order_id: PAID_ORDER_ID,
      payment_status: 'auth_ok',
      settled: false,
    }));
    expect(track).not.toHaveBeenCalledWith('checkout_completed', expect.anything());
    expect(localStorage.getItem('solidgate_main_recovery_v1')).toContain(PAID_ORDER_ID);
  });

  it('accepts the unified captured flag when legacy settlement aliases are absent', async () => {
    currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
    confirmSettledGrant.mockResolvedValue({
      ok: true,
      status: 'settle_ok',
      captured: true,
      resumeTo: '/oto/1',
      subscriptionId: 'sub_paid_123',
    });

    render(<OfferDetailsPage variant="main" />);

    await waitFor(() => {
      expect(track).toHaveBeenCalledWith('checkout_completed', expect.objectContaining({
        order_id: PAID_ORDER_ID,
        payment_status: 'settle_ok',
        settled: true,
      }));
    });
  });

  it('an indeterminate grant stays visible as pending and never reopens checkout', async () => {
    currentSearch = `sg_order=${encodeURIComponent(FREE_ORDER_ID)}`;
    confirmSettledGrant.mockRejectedValue(new Error('payment_pending'));

    render(<OfferDetailsPage variant="special-free" />);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('paymentPending');
    });
    expect(screen.queryByTestId('email-gate')).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('retries the same return order after a bounded poll ends pending', async () => {
    vi.useFakeTimers();
    try {
      currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
      confirmSettledGrant
        .mockRejectedValueOnce(new Error('payment_pending'))
        .mockReturnValueOnce(new Promise(() => {}));

      render(<OfferDetailsPage variant="main" />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole('status')).toHaveTextContent('paymentPending');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETURN_GRANT_RETRY_DELAY_MS);
      });

      expect(confirmSettledGrant).toHaveBeenCalledTimes(2);
      expect(confirmSettledGrant.mock.calls[0]?.[0]).toBe(PAID_ORDER_ID);
      expect(confirmSettledGrant.mock.calls[1]?.[0]).toBe(PAID_ORDER_ID);
      expect(routerReplace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops automatic return polling after the shared cap and keeps the same pending order', async () => {
    vi.useFakeTimers();
    try {
      currentSearch = `sg_order=${encodeURIComponent(PAID_ORDER_ID)}`;
      confirmSettledGrant.mockRejectedValue(new Error('payment_pending'));

      render(<OfferDetailsPage variant="main" />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETURN_GRANT_RETRY_DELAY_MS);
      });
      expect(confirmSettledGrant).toHaveBeenCalledTimes(RETURN_GRANT_MAX_ATTEMPTS);

      // A third cadence never starts. The URL-backed identity stays pending so
      // a manual refresh can reconcile this same order later.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RETURN_GRANT_MAX_AUTO_WAIT_MS);
      });
      expect(confirmSettledGrant).toHaveBeenCalledTimes(RETURN_GRANT_MAX_ATTEMPTS);
      expect(confirmSettledGrant.mock.calls.every(([orderId]) => orderId === PAID_ORDER_ID)).toBe(true);
      expect(screen.getByRole('status')).toHaveTextContent('paymentPending');
      expect(routerReplace).not.toHaveBeenCalled();
      expect(RETURN_GRANT_MAX_AUTO_WAIT_MS).toBe(
        RETURN_GRANT_MAX_ATTEMPTS * GRANT_POLL_BUDGET_MS + RETURN_GRANT_RETRY_DELAY_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows verification immediately and does not duplicate the return grant on rerender', async () => {
    currentSearch = `sg_order=${encodeURIComponent(FREE_ORDER_ID)}`;
    confirmSettledGrant.mockReturnValue(new Promise(() => {}));

    const view = render(<OfferDetailsPage variant="special-free" />);
    expect(screen.getByRole('status')).toHaveTextContent('completingVerification');
    view.rerender(<OfferDetailsPage variant="special-free" />);

    await waitFor(() => expect(confirmSettledGrant).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('email-gate')).toBeNull();
  });

  it('a failed grant on the main variant resumes the quiz redirect', async () => {
    currentSearch = `sg_order=${encodeURIComponent(`${SESSION_ID}:trial1:1`)}`;
    confirmSettledGrant.mockRejectedValue(new Error('void_ok'));

    render(<OfferDetailsPage variant="main" />);

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledWith('/offer');
    });
  });

  it('a garbage sg_order never suppresses the gate', async () => {
    currentSearch = 'sg_order=not-a-real-order';

    render(<OfferDetailsPage variant="special-free" />);

    await waitFor(() => {
      expect(screen.queryByTestId('email-gate')).not.toBeNull();
    });
    expect(confirmSettledGrant).not.toHaveBeenCalled();
  });
});
