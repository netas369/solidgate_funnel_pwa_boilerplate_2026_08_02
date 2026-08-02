interface OrderSummaryProps {
  productName: string;
  amountCents: number;
  currency?: string;
  /**
   * Phase 1028: pre-formatted, locale-aware price string from `formatPrice()`
   * (e.g. "€99.00", "2 499,00 Kč", "NT$3,299"). When provided, takes precedence
   * over the legacy `${currency} ${amountCents/100}` formatting and respects
   * zero-decimal currencies + locale-specific number grouping/symbol placement.
   */
  formattedPrice?: string;
  billingNote?: string;
  showTermsLink?: boolean;
  vatNote?: string;
  termsAgree?: string;
  termsLinkText?: string;
}

/**
 * Pre-button order summary for EU Article 8(2) compliance.
 * Displays product name, formatted price, VAT note, optional billing note,
 * and optional terms link -- all required before an obligation-to-pay button.
 */
export function OrderSummary({
  productName,
  amountCents,
  currency = 'EUR',
  formattedPrice: formattedPriceProp,
  billingNote,
  showTermsLink = true,
  vatNote = 'Price includes VAT where applicable.',
  termsAgree = 'By proceeding, you agree to our',
  termsLinkText = 'Terms of Service',
}: OrderSummaryProps) {
  const formattedPrice =
    formattedPriceProp ?? `${currency} ${(amountCents / 100).toFixed(2)}`;

  return (
    <div className="rounded-lg border border-si-outline-variant/20 bg-si-surface-container-low p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-si-on-surface">{productName}</span>
        <span className="font-bold text-si-primary">{formattedPrice}</span>
      </div>
      <p className="mt-1 text-xs text-si-on-surface-variant">
        {vatNote}
      </p>
      {billingNote && (
        <p className="mt-1 text-xs font-medium text-si-on-surface-variant">
          {billingNote}
        </p>
      )}
      {showTermsLink && (
        <p className="mt-2 text-xs text-si-on-surface-variant">
          {termsAgree}{' '}
          {/* Opens in a new tab: EU Art. 8(2) requires the terms to be
              readable without abandoning an in-progress checkout. */}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-si-primary"
          >
            {termsLinkText}
          </a>
          .
        </p>
      )}
    </div>
  );
}
