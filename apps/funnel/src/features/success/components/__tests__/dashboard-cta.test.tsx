import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// ─── Mocks ───────────────────────────────────────────────────────────────────
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/',
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/',
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <a {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>,
}));

const mockReset = vi.fn();
vi.mock('@/stores/quiz-store', () => ({
  useQuizStore: {
    getState: () => ({ reset: mockReset }),
  },
}));

import { NextIntlClientProvider } from 'next-intl';
import enSuccess from '@repo/i18n/messages/en/success.json';
import { DashboardCta } from '../dashboard-cta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intlMessages = { success: enSuccess } as any;
const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('DashboardCta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls useQuizStore.getState().reset() when clicked', () => {
    renderWithIntl(<DashboardCta />);

    fireEvent.click(screen.getByRole('button', { name: /go to my dashboard/i }));

    expect(mockReset).toHaveBeenCalledTimes(1);
  });

  it('calls reset before router.replace', () => {
    const callOrder: string[] = [];
    mockReset.mockImplementation(() => callOrder.push('reset'));
    mockReplace.mockImplementation(() => callOrder.push('replace'));

    renderWithIntl(<DashboardCta />);

    fireEvent.click(screen.getByRole('button', { name: /go to my dashboard/i }));

    expect(callOrder).toEqual(['reset', 'replace']);
    expect(mockReplace).toHaveBeenCalledWith('/dashboard');
  });
});
