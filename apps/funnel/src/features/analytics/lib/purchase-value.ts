// The `value` on purchase events (Meta Purchase, GTM, PostHog) is in MAJOR
// currency units. Most currencies store minor units (cents ÷ 100), but JPY has
// no minor unit — orders and PRICE_MAP hold whole yen, so dividing by 100
// would report a ¥926 sale to Meta as ¥9.26 and starve ad optimization of two
// orders of magnitude of value.

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

export function purchaseEventValue(amountCents: number, currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
    ? amountCents
    : amountCents / 100;
}
