// The sales body is the last thing a buyer reads before the pay button, so a
// missing message key here shows a raw `offer.pricing.*` path next to a price.
// next-intl does not throw for that in production — it renders the key — so
// this suite renders against the REAL en/offer.json and fails on any lookup
// error or unresolved ICU argument.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { formatPrice } from '@repo/shared/format-price';
import { resolveProductPrice } from '@repo/shared/price-map';
import enOffer from '@repo/i18n/messages/en/offer.json';
import { OfferSalesBody } from '../offer-sales-body';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const messages = { offer: enOffer } as any;

function renderBody(onUnlock = vi.fn(), onError?: (error: unknown) => void) {
  render(
    <NextIntlClientProvider locale="en" messages={messages} onError={onError}>
      <OfferSalesBody
        productId="trial1"
        checkoutOpen={false}
        preview
        onUnlock={onUnlock}
      />
    </NextIntlClientProvider>,
  );
}

describe('OfferSalesBody', () => {
  it('renders every message key it reads', () => {
    const onError = vi.fn();
    renderBody(vi.fn(), onError);
    expect(onError.mock.calls.map(([error]) => String(error))).toEqual([]);
    expect(document.body.textContent ?? '').not.toContain('offer.');
  });

  it('shows the resolved price and the pre-purchase disclosure above the CTA', () => {
    renderBody();
    // The amount comes from PRICE_MAP via locale -> currency, never a literal.
    const price = resolveProductPrice('trial1', 'en');
    expect(document.body.textContent).toContain(
      formatPrice(price.amountCents, price.currency, 'en'),
    );
    expect(screen.getByText(enOffer.pricing.disclaimer)).toBeTruthy();
  });

  it('routes the pricing CTA through onUnlock - the page owns the checkout', () => {
    const onUnlock = vi.fn();
    renderBody(onUnlock);
    screen.getByRole('button', { name: new RegExp(enOffer.pricing.card.cta, 'i') }).click();
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});
