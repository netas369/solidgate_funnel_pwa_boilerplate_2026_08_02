import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import enAuth from '@repo/i18n/messages/en/auth.json';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

const { mockGetUser, mockOnAuthStateChange, mockCreateClient } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockOnAuthStateChange: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
  mockCreateClient: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/success',
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/success',
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@repo/shared/supabase/client', () => ({
  createClient: mockCreateClient,
}));

import { AuthAvatar } from '../auth-avatar';
import { PostPaymentNav } from '../post-payment-nav';

// Real next-intl provider with the actual en/auth.json messages so the
// components render real translated copy (openLabel, dashboard, access, …).
const intlMessages = { auth: enAuth } as Record<string, unknown>;

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('AuthAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockReturnValue({
      auth: {
        getUser: mockGetUser,
        onAuthStateChange: mockOnAuthStateChange,
      },
    });
  });

  it('renders the H avatar and exposes the account-menu trigger', () => {
    renderWithIntl(<AuthAvatar email="buyer@example.com" />);

    // Trigger uses aria-label from auth.accountMenu.openLabel = "Open account menu".
    const trigger = screen.getByRole('button', { name: /open account menu/i });
    expect(trigger).toBeDefined();
    // The gradient avatar shows the static "H" glyph.
    expect(screen.getByText('H')).toBeDefined();
  });

  it('opens the dropdown to a Dashboard link and a Log out button', () => {
    renderWithIntl(<AuthAvatar email="buyer@example.com" />);

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));

    // Signed-in email is shown in the popup.
    expect(screen.getByText('buyer@example.com')).toBeDefined();
    // Dashboard is a menu link pointing at /dashboard.
    expect(
      screen.getByRole('menuitem', { name: /dashboard/i }).getAttribute('href'),
    ).toBe('/dashboard');
    // A single Log out action — no separate shared-device button.
    expect(screen.getByRole('button', { name: /log out/i })).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Use this device for someone else' }),
    ).toBeNull();
  });

  it('renders a single logout action without a separate shared-device button', () => {
    renderWithIntl(<AuthAvatar email="buyer@example.com" />);

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));

    expect(screen.getByRole('button', { name: /log out/i })).toBeDefined();
    expect(
      screen.queryByRole('button', { name: 'Use this device for someone else' }),
    ).toBeNull();
  });
});

describe('PostPaymentNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockReturnValue({
      auth: {
        getUser: mockGetUser,
        onAuthStateChange: mockOnAuthStateChange,
      },
    });
  });

  it('renders the brand wordmark and no avatar slot when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await act(async () => {
      renderWithIntl(<PostPaymentNav />);
    });

    // Brand short name comes from BOILERPLATE_BRAND.shortName (currently "Acme").
    expect(screen.getByText(BOILERPLATE_BRAND.shortName)).toBeDefined();
    // No authenticated user → no account-menu trigger.
    expect(
      screen.queryByRole('button', { name: /open account menu/i }),
    ).toBeNull();
  });

  it('renders the account-menu trigger when an initial email is provided', async () => {
    await act(async () => {
      renderWithIntl(<PostPaymentNav initialEmail="buyer@example.com" />);
    });

    expect(
      screen.getByRole('button', { name: /open account menu/i }),
    ).toBeDefined();
    // getUser is skipped when an initial email is already known.
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});
