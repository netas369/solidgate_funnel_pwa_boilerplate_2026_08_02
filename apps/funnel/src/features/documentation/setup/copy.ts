export const setupCopy = {
  title: 'Naujo appso mokėjimai',
  description: 'Užpildyk pasiūlymo laukus, patikrink kainas ir perduok paruoštą promptą agentui. Vienas pasiūlymas — vienas Solidgate produktas, jo valiutų kainos ir svetainės locale atitikmenys.',
  sections: [
    { id: 'produkto-taisykles', label: 'Taisyklės' },
    { id: 'setup-field-guide', label: 'Laukų žodynas' },
    { id: 'setup-transaction-example', label: 'Hub pavyzdžiai' },
    { id: 'setup-fields', label: 'Produkto laukai' },
    { id: 'setup-locales', label: 'Locale ir kainos' },
    { id: 'setup-currencies', label: 'Valiutų vienetai' },
    { id: 'setup-prompt', label: 'Agento promptas' },
  ],
  currencyExamples: [
    { code: 'EUR', amount: '5.00', exponent: 2, minor: '500' },
    { code: 'CZK', amount: '125.00', exponent: 2, minor: '12500' },
    { code: 'TWD', amount: '100', exponent: 2, minor: '10000' },
    { code: 'JPY', amount: '100', exponent: 0, minor: '100' },
    { code: 'KRW', amount: '100', exponent: 0, minor: '100' },
  ],
  sources: [
    { label: 'Solidgate: produktai', href: 'https://docs.solidgate.com/billing/manage-products/products/' },
    { label: 'Solidgate: kainos', href: 'https://docs.solidgate.com/billing/manage-products/prices/' },
    { label: 'Solidgate: valiutos', href: 'https://docs.solidgate.com/payments/payments-insights/supported-currencies/' },
    { label: 'Solidgate: PayPal valiutų taisyklės', href: 'https://docs.solidgate.com/payments/alternative-payments/apms-overview/paypal/' },
  ],
} as const;
