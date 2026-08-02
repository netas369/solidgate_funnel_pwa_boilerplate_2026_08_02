import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enSuccess from '@repo/i18n/messages/en/success.json';
import { OrderSummaryCard } from '../order-summary-card';

const renderWithIntl = (ui: React.ReactElement) =>
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <NextIntlClientProvider locale="en" messages={{ success: enSuccess } as any}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('OrderSummaryCard', () => {
  it('renders a row for each order with product_name and a formatted EUR price', () => {
    renderWithIntl(
      <OrderSummaryCard
        orders={[
          { id: '1', product_name: 'Product A', product_slug: null, amount_cents: 500, currency: 'eur' },
          { id: '2', product_name: 'Product B', product_slug: null, amount_cents: 9900, currency: 'eur' },
        ]}
      />,
    );
    expect(screen.getByText('Product A')).toBeTruthy();
    expect(screen.getByText('Product B')).toBeTruthy();
    // formatPrice(en, eur) -> Intl.NumberFormat('en-US', { currency: 'EUR' }).
    expect(screen.getByText(/€5\.00/)).toBeTruthy();
    expect(screen.getByText(/€99\.00/)).toBeTruthy();
  });

  it('renders the order.totalPaid heading and sums amount_cents across orders', () => {
    renderWithIntl(
      <OrderSummaryCard
        orders={[
          { id: '1', product_name: 'A', product_slug: null, amount_cents: 500, currency: 'eur' },
          { id: '2', product_name: 'B', product_slug: null, amount_cents: 9900, currency: 'eur' },
        ]}
      />,
    );
    // CURRENT en/success.json order.totalPaid copy is "Total paid" (lowercase p).
    expect(screen.getByText('Total paid')).toBeTruthy();
    // 500 + 9900 = 10400 cents -> €104.00, exposed via data-testid="total-paid".
    expect(screen.getByTestId('total-paid').textContent).toMatch(/€104\.00/);
  });

  it('renders the order.loading empty-state copy when orders array is empty', () => {
    renderWithIntl(<OrderSummaryCard orders={[]} />);
    expect(screen.getByText(/order details are loading/i)).toBeTruthy();
  });

  it('prefers a translated orderProducts label when product_slug resolves a key', () => {
    // orderProducts.oto1_lifetime -> "Lifetime Access" in en/success.json.
    // The DB product_slug takes precedence over the raw product_name.
    renderWithIntl(
      <OrderSummaryCard
        orders={[
          {
            id: 'o1',
            product_name: 'RAW_COMPANY_CODE_SUB',
            product_slug: 'oto1_lifetime',
            amount_cents: 9900,
            currency: 'eur',
          },
        ]}
      />,
    );
    expect(screen.getByText('Lifetime Access')).toBeTruthy();
    expect(screen.queryByText('RAW_COMPANY_CODE_SUB')).toBeNull();
  });

  it('falls back to the raw product_name when the slug has no orderProducts key', () => {
    renderWithIntl(
      <OrderSummaryCard
        orders={[
          {
            id: 'o1',
            product_name: 'Custom Unmapped Product',
            product_slug: 'totally_unknown_slug',
            amount_cents: 1200,
            currency: 'eur',
          },
        ]}
      />,
    );
    expect(screen.getByText('Custom Unmapped Product')).toBeTruthy();
  });
});
