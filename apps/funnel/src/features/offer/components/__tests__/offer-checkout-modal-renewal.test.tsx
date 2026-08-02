// OfferCheckoutModal  -  modal wrapper around the Solidgate hosted checkout.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { forwardRef } from 'react';

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

// ─── motion/react mock  -  strip animation props ───────────────────────────
vi.mock('motion/react', () => ({
  motion: {
    div: forwardRef(function MotionDiv(
      { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
      ref: React.Ref<HTMLDivElement>,
    ) {
      const animationProps = new Set(['initial', 'animate', 'exit', 'transition', 'variants']);
      const validProps = Object.fromEntries(
        Object.entries(props).filter(([key]) => !animationProps.has(key)),
      );
      return <div ref={ref} {...(validProps as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;
    }),
  },
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

// ─── analytics mock ────────────────────────────────────────────────────────
const mockTrack = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

// ─── SolidgateCheckout mock  -  the hosted form iframe needs a real browser ─
// Surfaces the props the modal forwards (productId, intent, sessionId) so the
// test can assert wiring.
vi.mock('@/components/checkout/solidgate-checkout', async () => {
  // CHECKOUT_ERROR_CODES stays real: the modal maps it to translations, so a
  // stubbed list would hide a missing i18n key instead of surfacing it.
  const actual = await vi.importActual<
    typeof import('@/components/checkout/solidgate-checkout')
  >('@/components/checkout/solidgate-checkout');
  return {
    CHECKOUT_ERROR_CODES: actual.CHECKOUT_ERROR_CODES,
    SolidgateCheckout: (props: {
      productId: string;
      sessionId: string | null;
      buttonText: string;
      price: string;
      intent?: boolean;
      errorMessages?: Record<string, string>;
      processingLabel?: string;
      onProcessingChange?: (processing: boolean) => void;
    }) => (
      <div
        data-testid="solidgate-checkout"
        data-product-id={props.productId}
        data-session-id={String(props.sessionId)}
        data-intent={String(props.intent ?? false)}
        data-price={props.price}
        data-processing-label={props.processingLabel}
        data-error-codes={Object.keys(props.errorMessages ?? {}).sort().join(',')}
      >
        <button type="button">{props.buttonText}</button>
        <button type="button" onClick={() => props.onProcessingChange?.(true)}>
          Simulate processing
        </button>
        <button type="button" onClick={() => props.onProcessingChange?.(false)}>
          Finish processing
        </button>
      </div>
    ),
  };
});

import { NextIntlClientProvider } from 'next-intl';
import enOffer from '@repo/i18n/messages/en/offer.json';
import { CHECKOUT_ERROR_CODES } from '@/components/checkout/solidgate-checkout';
import { FUNNEL_CODE } from '@/features/analytics/lib/checkout-context';
import { OfferCheckoutModal } from '../offer-checkout-modal';
import { OFFER_PRICING_TIERS } from '../../config/offer-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intlMessages = { offer: enOffer } as any;
const renderWithIntl = (ui: React.ReactElement) =>
  render(
    <NextIntlClientProvider locale="en" messages={intlMessages}>
      {ui}
    </NextIntlClientProvider>,
  );

// A representative trial tier from the CURRENT catalog (trial1..trial4).
const TRIAL_TIER = OFFER_PRICING_TIERS.find((tier) => tier.productId === 'trial1')!;

describe('OfferCheckoutModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.style.overflow = '';
    window.history.pushState({}, '', '/');
  });

  it('does not render the dialog when open is false', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open={false}
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('solidgate-checkout')).toBeNull();
  });

  it('does not render the dialog when tier is null even if open is true', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={null}
        sessionId="sess-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the checkout dialog with the Solidgate checkout when open with a tier', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('solidgate-checkout')).toBeTruthy();
  });

  it('forwards productId, sessionId and intent=true to the checkout', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-abc"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const checkout = screen.getByTestId('solidgate-checkout');
    expect(checkout.getAttribute('data-product-id')).toBe(TRIAL_TIER.productId);
    expect(checkout.getAttribute('data-session-id')).toBe('sess-abc');
    // 260413-rfc: intent={true} so the order is opened only once the modal is
    // open with a selected tier.
    expect(checkout.getAttribute('data-intent')).toBe('true');
    expect(checkout.getAttribute('data-processing-label')).toBe(
      enOffer.checkoutModal.processing,
    );
  });

  /**
   * Production showed Czech buyers a red `INTRO_OFFER_IN_PROGRESS` where the
   * card form belonged. Every code the checkout can raise must arrive already
   * translated, so a missing key fails here rather than in front of a buyer.
   */
  it('hands the checkout translated copy for every error code it can raise', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-abc"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    const checkout = screen.getByTestId('solidgate-checkout');
    expect(checkout.getAttribute('data-error-codes')).toBe(
      [...CHECKOUT_ERROR_CODES].sort().join(','),
    );
    for (const code of CHECKOUT_ERROR_CODES) {
      const copy = enOffer.checkoutModal.errors[code as keyof typeof enOffer.checkoutModal.errors];
      expect(copy, `missing copy for ${code}`).toBeTruthy();
      expect(copy).not.toBe(code);
    }
  });

  it('fires checkout_opened analytics once when the modal opens with a tier', () => {
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'checkout_opened',
      expect.objectContaining({
        product: TRIAL_TIER.productId,
        product_slug: TRIAL_TIER.productId,
        product_id: expect.any(String),
        price_id: expect.any(String),
        funnel_code: FUNNEL_CODE,
        funnel_variant: 'main',
      }),
    );
    const openedCalls = mockTrack.mock.calls.filter(([event]) => event === 'checkout_opened');
    expect(openedCalls).toHaveLength(1);
  });

  it('calls onClose when the Escape key is pressed', () => {
    const onClose = vi.fn();
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={onClose}
        onSuccess={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={onClose}
        onSuccess={vi.fn()}
      />,
    );
    // offer.checkoutModal.closeLabel -> "Close checkout".
    fireEvent.click(screen.getByRole('button', { name: /close checkout/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('prevents Escape and close-button dismissal while payment is in flight', () => {
    const onClose = vi.fn();
    renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={onClose}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Simulate processing' }));
    const closeButton = screen.getByRole('button', { name: /close checkout/i });
    expect(closeButton).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finish processing' }));
    expect(closeButton).not.toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('locks body scroll while open and restores it on unmount', () => {
    const { unmount } = renderWithIntl(
      <OfferCheckoutModal
        open
        tier={TRIAL_TIER}
        sessionId="sess-1"
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
