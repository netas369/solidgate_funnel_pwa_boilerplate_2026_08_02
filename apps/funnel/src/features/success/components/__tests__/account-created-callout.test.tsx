import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enSuccess from '@repo/i18n/messages/en/success.json';
import { AccountCreatedCallout } from '../account-created-callout';

const renderWithIntl = (ui: React.ReactElement) =>
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <NextIntlClientProvider locale="en" messages={{ success: enSuccess } as any}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('AccountCreatedCallout', () => {
  // Asserts against the CURRENT en/success.json `account.*` keys:
  //   account.heading      -> "Your account is ready"
  //   account.description  -> "We created a free account on {email}. To log in
  //                            next time, enter your email and use the 6 digit
  //                            code we send you. No password needed."
  it('renders the account.heading copy', () => {
    renderWithIntl(<AccountCreatedCallout email="user@example.com" />);
    expect(screen.getByText('Your account is ready')).toBeTruthy();
  });

  it('interpolates the email prop into the description body copy', () => {
    renderWithIntl(<AccountCreatedCallout email="user@example.com" />);
    // account.description uses an {email} placeholder; the rendered text node
    // contains the literal address.
    expect(screen.getByText(/user@example\.com/)).toBeTruthy();
  });

  it('explains the passwordless 6 digit code login flow', () => {
    renderWithIntl(<AccountCreatedCallout email="user@example.com" />);
    expect(screen.getByText(/6-digit code/i)).toBeTruthy();
    expect(screen.getByText(/no password needed/i)).toBeTruthy();
  });

  it('renders the email inside the description, distinct from the heading', () => {
    renderWithIntl(<AccountCreatedCallout email="someone@example.com" />);
    const heading = screen.getByText('Your account is ready');
    const body = screen.getByText(/someone@example\.com/);
    expect(heading).not.toBe(body);
    // The description sits in a <p>, the heading in an <h2>.
    expect(body.tagName.toLowerCase()).toBe('p');
    expect(heading.tagName.toLowerCase()).toBe('h2');
  });
});
