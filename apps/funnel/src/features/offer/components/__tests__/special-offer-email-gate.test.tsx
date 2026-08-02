/* eslint-disable react/display-name -- these are inline vi.mock() stand-ins for motion/react primitives, not components anyone renders by name in a devtools tree. */
// SpecialOfferEmailGate  -  hard-block email gate for /[locale]/special-offer.
//
// Contracts asserted against the CURRENT component:
//   HARD-BLOCK  -  no Escape close, no backdrop close, no X button. The modal
//                  is dismissible ONLY via a resolved form submission.
//   EMAIL-ONLY  -  no GDPR / marketing / consent checkbox, and no second step.
//   NO URL PREFILL  -  ?email=... in the URL does NOT populate the input.
//   onSubmit(sessionId) fires exactly once, only after /api/session/persist
//   accepts the address. A 409 already_subscribed must NOT resolve the gate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { forwardRef } from 'react';

// ─── i18n mock  -  identity translator + fixed locale ───────────────────────
vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

// ─── motion/react mock  -  strip animation props so jsdom renders cleanly ──
vi.mock('motion/react', () => ({
  motion: {
    div: forwardRef(
      (
        { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
        _ref: React.Ref<HTMLDivElement>,
      ) => {
        const {
          initial: _i,
          animate: _a,
          exit: _e,
          transition: _t,
          variants: _v,
          ...validProps
        } = props;
        return (
          <div {...(validProps as React.HTMLAttributes<HTMLDivElement>)}>
            {children}
          </div>
        );
      },
    ),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  useReducedMotion: () => false,
  useInView: () => true,
}));

// ─── global.fetch mock  -  the gate POSTs to /api/session/persist ──────────
const mockFetch = vi.fn();

import { SpecialOfferEmailGate } from '../special-offer-email-gate';

describe('SpecialOfferEmailGate  -  hard-block contract', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Default: persist succeeds, so a valid submit resolves the gate.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    // @ts-expect-error  -  restore fetch
    delete global.fetch;
  });

  it('renders an email input with autofocus on mount', async () => {
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} />);
    const input =
      screen.queryByRole('textbox', { name: /email/i }) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLElement | null);
    expect(input).toBeTruthy();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('does NOT close when the user presses Escape (no onClose handler exists)', () => {
    const onSubmit = vi.fn();
    render(<SpecialOfferEmailGate onSubmit={onSubmit} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT close when the user clicks the backdrop overlay', () => {
    const onSubmit = vi.fn();
    render(<SpecialOfferEmailGate onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders no consent / gdpr / marketing controls on the email step (email-only)', () => {
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText(/consent/i)).toBeNull();
    expect(screen.queryByLabelText(/gdpr/i)).toBeNull();
    expect(screen.queryByLabelText(/marketing/i)).toBeNull();
    expect(screen.queryByText(/gdpr/i)).toBeNull();
    expect(screen.queryByText(/marketing/i)).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('has no close / dismiss button', () => {
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} />);
    expect(
      screen.queryByRole('button', { name: /close|dismiss|✕|×/i }),
    ).toBeNull();
    expect(screen.queryByLabelText(/close/i)).toBeNull();
  });

  it('does NOT pre-populate the email field from URL search params', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: {
        ...window.location,
        search: '?email=leak@example.com',
        href: 'http://localhost/en/special-offer?email=leak@example.com',
      },
    });
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);
    expect(input).toBeTruthy();
    expect(input!.value).toBe('');
  });

  it('rejects an invalid email with the i18n invalidEmail error message', async () => {
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: /submitButton/i }));

    await waitFor(() => {
      // The identity translator returns the key, so invalidEmail renders verbatim.
      expect(screen.getByText(/invalidEmail/i)).toBeInTheDocument();
    });
    // No network call on a client-side validation failure.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('POSTs to /api/session/persist with source "special-offer" by default', async () => {
    const onSubmit = vi.fn();
    render(<SpecialOfferEmailGate onSubmit={onSubmit} />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: 'real@user.io' } });
    fireEvent.click(screen.getByRole('button', { name: /submitButton/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/session/persist',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"source":"special-offer"'),
        }),
      );
    });
  });

  it('POSTs source "special-offer-free" when the source prop is the free variant', async () => {
    render(<SpecialOfferEmailGate onSubmit={vi.fn()} source="special-offer-free" />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);
    expect(input).toBeTruthy();

    fireEvent.change(input!, { target: { value: 'free@user.io' } });
    fireEvent.click(screen.getByRole('button', { name: /submitButton/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/session/persist',
        expect.objectContaining({
          body: expect.stringContaining('"source":"special-offer-free"'),
        }),
      );
    });
  });

  it('calls onSubmit with the minted sessionId once persist accepts the email', async () => {
    const onSubmit = vi.fn();
    render(<SpecialOfferEmailGate onSubmit={onSubmit} />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);

    fireEvent.change(input!, { target: { value: 'real@user.io' } });
    fireEvent.click(screen.getByRole('button', { name: /submitButton/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [sessionId] = onSubmit.mock.calls[0];
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it('locks the form into a login state when persist returns 409 already_subscribed', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'already_subscribed' }),
    });
    const onSubmit = vi.fn();
    render(<SpecialOfferEmailGate onSubmit={onSubmit} />);
    const input =
      (screen.queryByRole('textbox', { name: /email/i }) as HTMLInputElement | null) ??
      (screen.queryByPlaceholderText(/email/i) as HTMLInputElement | null);

    fireEvent.change(input!, { target: { value: 'member@user.io' } });
    fireEvent.click(screen.getByRole('button', { name: /submitButton/i }));

    // The already-subscribed callout exposes a login CTA link.
    await waitFor(() => {
      expect(
        screen.getByText(/alreadySubscribed\.loginCta/i),
      ).toBeInTheDocument();
    });
    // 409 must NOT resolve the gate.
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
