import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrderSummary } from '../order-summary';

describe('OrderSummary', () => {
  const defaultProps = {
    productName: 'Digital Product 4 (PDF)',
    amountCents: 999,
  };

  it('renders productName text', () => {
    render(<OrderSummary {...defaultProps} />);
    expect(
      screen.getByText('Digital Product 4 (PDF)'),
    ).toBeDefined();
  });

  it('renders formatted price as EUR X.XX', () => {
    render(<OrderSummary {...defaultProps} />);
    expect(screen.getByText('EUR 9.99')).toBeDefined();
  });

  it('renders VAT note', () => {
    render(<OrderSummary {...defaultProps} />);
    expect(
      screen.getByText('Price includes VAT where applicable.'),
    ).toBeDefined();
  });

  it('renders terms link pointing to /terms with target="_blank"', () => {
    render(<OrderSummary {...defaultProps} />);
    const link = screen.getByRole('link', { name: /Terms of Service/i });
    expect(link.getAttribute('href')).toBe('/terms');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does NOT render terms link when showTermsLink={false}', () => {
    render(<OrderSummary {...defaultProps} showTermsLink={false} />);
    expect(
      screen.queryByRole('link', { name: /Terms of Service/i }),
    ).toBeNull();
  });

  it('renders billing note when provided', () => {
    render(
      <OrderSummary
        {...defaultProps}
        billingNote="Free for 7 days, then EUR 19/week. Cancel anytime."
      />,
    );
    expect(
      screen.getByText(
        'Free for 7 days, then EUR 19/week. Cancel anytime.',
      ),
    ).toBeDefined();
  });

  it('does NOT render billing note when not provided', () => {
    const { container } = render(<OrderSummary {...defaultProps} />);
    const paragraphs = container.querySelectorAll('p');
    const texts = Array.from(paragraphs).map((p) => p.textContent);
    expect(texts.some((t) => t?.includes('Free for 7 days'))).toBe(false);
  });
});
