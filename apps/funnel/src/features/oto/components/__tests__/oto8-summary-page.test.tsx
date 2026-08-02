import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  track: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => Object.assign(
    (key: string) => key,
    { raw: () => [] },
  ),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('@/stores/quiz-store', () => ({
  useQuizStore: (selector: (state: { sessionId: string }) => unknown) => selector({
    sessionId: SESSION_ID,
  }),
}));

vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({
  useQuizHydration: () => true,
}));

vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mocks.track }),
}));

vi.mock('@/features/oto/lib/use-oto-progress-recovery', () => ({
  useOtoProgressRecovery: vi.fn(),
}));

vi.mock('@/features/oto/lib/use-accepted-oto-recovery', () => ({
  useAcceptedOtoRecovery: vi.fn(),
  reconcileAcceptedOtoRecoverySweep: mocks.reconcile,
}));

vi.mock('@/app/[locale]/_components/landing/LandingNav', () => ({
  LandingNav: () => null,
}));

const { Oto8SummaryPage } = await import('../oto8-summary-page');

describe('OTO8 app handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ orders: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
  });

  it('does not leave the funnel while an accepted OTO is still ambiguous', async () => {
    mocks.reconcile.mockResolvedValue({
      attemptedOrderIds: [`${SESSION_ID}:oto3_bundle_all:1`],
      pendingOrderIds: [`${SESSION_ID}:oto3_bundle_all:1`],
      redirectUrl: null,
      queueEmpty: false,
    });

    render(<Oto8SummaryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'cta' }));

    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith({ sessionId: SESSION_ID }));
    expect(mocks.push).not.toHaveBeenCalledWith('/dashboard');
    expect(mocks.track).not.toHaveBeenCalledWith('oto8_open_app', expect.anything());
    expect(screen.getByRole('status')).toHaveTextContent('paymentPending');
    expect(screen.getByRole('button', { name: 'cta' })).toBeEnabled();
  });
});
