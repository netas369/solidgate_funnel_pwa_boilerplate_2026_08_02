export type PaymentEnvironment = 'production' | 'sandbox';

/**
 * Production is the only runtime allowed to touch live payment state. Vercel
 * Preview, local development and tests all use the isolated sandbox ledger.
 */
export function paymentEnvironmentForVercel(
  vercelEnvironment: string | undefined,
): PaymentEnvironment {
  return vercelEnvironment === 'production' ? 'production' : 'sandbox';
}

export function currentPaymentEnvironment(): PaymentEnvironment {
  return paymentEnvironmentForVercel(
    typeof process === 'undefined' ? undefined : process.env.VERCEL_ENV,
  );
}
