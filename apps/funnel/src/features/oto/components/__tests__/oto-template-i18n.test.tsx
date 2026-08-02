// A config-driven template invites exactly one silent failure: a slot whose
// message keys were never authored. next-intl does not throw for a missing key
// in production — it renders the key path — so a buyer would see
// `oto.oto6.disclaimer` where the pre-purchase disclosure belongs.
//
// This suite renders all seven slots against the REAL en/oto.json and fails on
// any missing key or unresolved ICU argument.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/stores/quiz-store', () => {
  const state = {
    sessionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    isComplete: true,
    authorizedViaPurchase: false,
  };
  const useQuizStore = (selector: (s: typeof state) => unknown) => selector(state);
  useQuizStore.getState = () => ({ ...state, grantPurchaseAuthorization: vi.fn() });
  return { useQuizStore };
});
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (s: { setStage: () => void }) => unknown) =>
    selector({ setStage: vi.fn() }),
}));
vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({ useQuizHydration: () => true }));
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-scroll-to-top', () => ({ useScrollToTop: vi.fn() }));
vi.mock('@/features/oto/lib/use-solidgate-oto-resume', () => ({
  useSolidgateOtoResume: vi.fn(),
}));
vi.mock('@/features/oto/lib/use-oto-progress-recovery', () => ({
  useOtoProgressRecovery: vi.fn(),
}));
vi.mock('@/app/[locale]/_components/landing/LandingNav', () => ({ LandingNav: () => null }));

import enOto from '@repo/i18n/messages/en/oto.json';
import enCommon from '@repo/i18n/messages/en/common.json';
import { OtoTemplate } from '../oto-template';
import { OTO_CONFIG, OTO_STEPS } from '../../config/oto-config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messages = { oto: enOto, common: enCommon } as any;

describe('OtoTemplate i18n coverage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ brand: 'VISA', last4: '4242' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });

  it.each(OTO_STEPS)('slot %i renders every key it reads', (step) => {
    const onError = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages} onError={onError}>
        <OtoTemplate config={OTO_CONFIG[step]} />
      </NextIntlClientProvider>,
    );

    const namespace = OTO_CONFIG[step].i18nNamespace;
    expect(
      onError.mock.calls.map(([error]) => String(error)),
      `missing/broken messages under ${namespace}`,
    ).toEqual([]);

    // Nothing rendered may look like a raw key path.
    expect(document.body.textContent ?? '').not.toContain(namespace);
    expect(screen.getByRole('button', { name: enOto[`oto${step}` as 'oto1'].cta })).toBeTruthy();
  });

  it('renders one selectable option per configured product on the multi-option slot', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <OtoTemplate config={OTO_CONFIG[3]} />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(OTO_CONFIG[3].options.length);
  });
});
