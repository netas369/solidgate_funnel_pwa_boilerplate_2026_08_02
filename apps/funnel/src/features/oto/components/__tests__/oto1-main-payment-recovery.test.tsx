// The ?sg_main settlement bridge + saved-card gate on OTO slot 1, exercised
// through the real OtoTemplate. This is the ONLY coverage of the recovery path
// between the main checkout and the OTO chain — do not delete it.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:trial3:1`;

let currentSearch = '';
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  track: vi.fn(),
  setStage: vi.fn(),
  quiz: {
    sessionId: null as string | null,
    isComplete: false,
    authorizedViaPurchase: false,
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => Object.assign(
    (key: string) => key,
    { raw: () => [] },
  ),
}));

vi.mock('@/stores/quiz-store', () => {
  const getState = () => ({
    ...mocks.quiz,
    grantPurchaseAuthorization: (sessionId: string) => {
      mocks.quiz.sessionId = sessionId;
      mocks.quiz.authorizedViaPurchase = true;
    },
  });
  return {
    useQuizStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState },
    ),
  };
});

vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (state: { setStage: typeof mocks.setStage }) => unknown) =>
    selector({ setStage: mocks.setStage }),
}));

vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({ useQuizHydration: () => true }));
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mocks.track }),
}));
vi.mock('@/features/oto/lib/use-solidgate-oto-resume', () => ({
  useSolidgateOtoResume: vi.fn(),
}));
vi.mock('@/features/oto/lib/use-oto-progress-recovery', () => ({
  useOtoProgressRecovery: vi.fn(),
}));
vi.mock('@/lib/hooks/use-scroll-to-top', () => ({ useScrollToTop: vi.fn() }));
vi.mock('@/app/[locale]/_components/landing/LandingNav', () => ({
  LandingNav: () => null,
}));
// The catalog guard is about an unseeded install, not about this flow.
vi.mock('@/features/checkout/lib/catalog-seed', () => ({
  solidgateCatalogError: () => null,
  SOLIDGATE_SEED_COMMAND: 'seed',
}));
vi.mock('@/features/oto/lib/advance-oto', () => ({
  advanceOtoBeforeNavigation: vi.fn(),
  resolveOtoNavigationTarget: () => '/oto/2',
}));
vi.mock('@/features/oto/lib/charge-oto', () => ({
  chargeOtoSolidgate: vi.fn(),
  otoLifecycleEventProperties: () => ({}),
  otoPmInfoUrl: (sessionId: string) => `/api/solidgate/pm-info?sessionId=${sessionId}`,
  otoPurchaseEventProperties: () => ({}),
}));

const { OtoTemplate } = await import('../oto-template');
const { OTO_CONFIG } = await import('../../config/oto-config');
const { FUNNEL_CODE } = await import('@/features/analytics/lib/checkout-context');
const {
  MAIN_PAYMENT_RECOVERY_STORAGE_KEY,
  saveMainPaymentRecovery,
} = await import('../../lib/main-payment-recovery');

const Oto1Page = () => <OtoTemplate config={OTO_CONFIG[1]} />;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OTO1 accepted main-payment recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    currentSearch = `sg_main=${encodeURIComponent(ORDER_ID)}`;
    mocks.quiz.sessionId = null;
    mocks.quiz.isComplete = false;
    mocks.quiz.authorizedViaPurchase = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('unlocks both decisions on the accepted authorization, then finishes capture in the background', async () => {
    // The accepted state repeats until Solidgate settles: the unlocked page
    // keeps watching the same order in the background. Keyed on provider
    // state, not poll count — re-renders may restart the poll loop.
    let providerSettled = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/solidgate/grant') {
        return Promise.resolve(providerSettled
          ? jsonResponse({ ok: true, captured: true, status: 'settle_ok' }, 200)
          : jsonResponse({
              ok: false,
              pending: true,
              accepted: true,
              authorized: true,
              orderId: ORDER_ID,
              status: 'auth_ok',
            }, 202));
      }
      if (url.startsWith('/api/solidgate/pm-info')) {
        return Promise.resolve(jsonResponse({ brand: 'VISA', last4: '2692' }, 200));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    saveMainPaymentRecovery({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      checkout: {
        payment_provider: 'solidgate',
        billing_type: 'subscription_initial',
        surface: 'funnel',
        funnel_code: FUNNEL_CODE,
        funnel_variant: 'main',
        product: 'trial3',
        product_id: `${FUNNEL_CODE}_000000_SUB`,
        product_code: `${FUNNEL_CODE}_000000_SUB`,
        product_name: 'Main Subscription',
        product_slug: 'trial3',
        price_id: 'price-1',
        solidgate_product_id: 'product-1',
        solidgate_price_id: 'price-1',
        amount_cents: 1300,
        currency: 'USD',
      },
    });

    render(<Oto1Page />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The verified paid authorization unlocks the page before capture: the
    // saved card is loadable and both decisions are live while the recovery
    // marker keeps watching the same order for its settlement.
    const buy = screen.getByRole('button', { name: 'cta' });
    const decline = screen.getByRole('button', { name: 'ctaDecline' });
    expect(buy).toBeEnabled();
    expect(decline).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY)).not.toBeNull();
    expect(mocks.track).not.toHaveBeenCalledWith('checkout_completed', expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/solidgate/pm-info'),
      expect.objectContaining({ credentials: 'same-origin' }),
    );

    providerSettled = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(buy).toBeEnabled();
    expect(decline).toBeEnabled();
    expect(mocks.replace).toHaveBeenCalledWith('/oto/1');
    expect(localStorage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(mocks.track).toHaveBeenCalledWith('checkout_completed', expect.objectContaining({
      order_id: ORDER_ID,
      amount_cents: 1300,
      currency: 'USD',
      payment_status: 'settle_ok',
      settled: true,
      value: 13,
    }));
  });

  it('keeps both decisions locked while the payment is only pending, without an accepted authorization', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/solidgate/grant') {
        return Promise.resolve(jsonResponse({
          ok: false,
          pending: true,
          orderId: ORDER_ID,
          status: 'processing',
        }, 202));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    saveMainPaymentRecovery({ orderId: ORDER_ID, sessionId: SESSION_ID });

    render(<Oto1Page />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'cta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ctaDecline' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('paymentPending');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'cta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ctaDecline' })).toBeDisabled();
    expect(localStorage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY)).not.toBeNull();
  });

  it('retries a temporarily missing saved card and enables the purchase CTA when it appears', async () => {
    currentSearch = '';
    mocks.quiz.sessionId = SESSION_ID;
    mocks.quiz.isComplete = true;

    let pmInfoCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith('/api/solidgate/pm-info')) {
        throw new Error(`Unexpected fetch ${url}`);
      }
      pmInfoCalls += 1;
      return Promise.resolve(pmInfoCalls === 1
        ? jsonResponse({ code: 'no_saved_card' }, 409)
        : jsonResponse({ brand: 'VISA', last4: '2692' }, 200));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Oto1Page />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'cta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ctaDecline' })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.resolve();
    });

    expect(pmInfoCalls).toBe(2);
    expect(screen.getByRole('button', { name: 'cta' })).toBeEnabled();
    expect(screen.getByText('savedCard')).toBeInTheDocument();
  });

  it('bounds hanging saved-card checks and lets the customer manually retry', async () => {
    currentSearch = '';
    mocks.quiz.sessionId = SESSION_ID;
    mocks.quiz.isComplete = true;

    let returnSavedCard = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('/api/solidgate/pm-info')) {
        throw new Error(`Unexpected fetch ${url}`);
      }
      if (returnSavedCard) {
        return Promise.resolve(jsonResponse({ brand: 'VISA', last4: '2692' }, 200));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Oto1Page />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.resolve();
    });

    expect(screen.getByText('savedCardMissing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ctaDecline' })).toBeEnabled();

    returnSavedCard = true;
    fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'cta' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'tryAgain' })).not.toBeInTheDocument();
  });
});
