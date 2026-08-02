import {
  buildSolidgateOrderId,
  parseSolidgateOrderId,
} from '@repo/shared/solidgate/order-id';
import {
  FUNNEL_CODE,
  type CheckoutProductContext,
} from '@/features/analytics/lib/checkout-context';
import { MAIN_PRODUCT_IDS } from '@/features/offer/config/offer-data';

export const MAIN_PAYMENT_RECOVERY_STORAGE_KEY = 'solidgate_main_recovery_v1';
export const MAIN_PAYMENT_RECOVERY_MAX_AGE_MS = 10 * 60 * 1_000;

const SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Derived from the offer tier config: a tier added there must be recoverable
// here, or a 3DS round-trip silently strands that buyer. FUNNEL_CODE comes from
// checkout-context so the code emitted by the checkout, the proxy and this
// validator can never drift apart — a mismatch disables ?sg_main / ?sg_order
// recovery for EVERY buyer without raising anything.
const MAIN_TIERS = new Set<string>(MAIN_PRODUCT_IDS);

export type MainPaymentRecoveryMarker = {
  version: 1;
  orderId: string;
  sessionId: string;
  createdAt: number;
  checkout?: CheckoutProductContext;
};

function normalizedCheckout(value: unknown): CheckoutProductContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const product = source.product;
  const expectedVariant = product === 'special_1eur' || product === 'special_free'
    ? product
    : 'main';
  const requiredStrings = [
    'funnel_variant',
    'product_id',
    'product_code',
    'product_name',
    'product_slug',
    'price_id',
    'solidgate_product_id',
    'solidgate_price_id',
    'currency',
  ] as const;
  if (
    source.payment_provider !== 'solidgate' ||
    source.billing_type !== 'subscription_initial' ||
    source.surface !== 'funnel' ||
    source.funnel_code !== FUNNEL_CODE ||
    typeof product !== 'string' ||
    !MAIN_TIERS.has(product) ||
    source.funnel_variant !== expectedVariant ||
    source.product_slug !== product ||
    !Number.isSafeInteger(source.amount_cents) ||
    (source.amount_cents as number) < 0 ||
    requiredStrings.some((key) => (
      typeof source[key] !== 'string' ||
      (source[key] as string).length === 0 ||
      (source[key] as string).length > 380
    )) ||
    !/^[A-Z]{3}$/.test(source.currency as string)
  ) return null;
  return {
    payment_provider: 'solidgate',
    billing_type: 'subscription_initial',
    surface: 'funnel',
    funnel_code: FUNNEL_CODE,
    funnel_variant: source.funnel_variant as CheckoutProductContext['funnel_variant'],
    product: product as CheckoutProductContext['product'],
    product_id: source.product_id as string,
    product_code: source.product_code as string,
    product_name: source.product_name as string,
    product_slug: product as CheckoutProductContext['product_slug'],
    price_id: source.price_id as string,
    solidgate_product_id: source.solidgate_product_id as string,
    solidgate_price_id: source.solidgate_price_id as string,
    amount_cents: source.amount_cents as number,
    currency: source.currency as string,
  };
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseMainPaymentRecoveryOrder(
  orderId: unknown,
): { orderId: string; sessionId: string } | null {
  if (typeof orderId !== 'string' || orderId.length > 255) return null;
  const parsed = parseSolidgateOrderId(orderId);
  if (
    !parsed ||
    !SESSION_UUID_PATTERN.test(parsed.sessionId) ||
    !MAIN_TIERS.has(parsed.offeringSlug) ||
    !Number.isSafeInteger(parsed.attempt) ||
    parsed.attempt > 999_999_999
  ) return null;
  try {
    if (buildSolidgateOrderId(parsed.sessionId, parsed.offeringSlug, parsed.attempt) !== orderId) {
      return null;
    }
  } catch {
    return null;
  }
  return { orderId, sessionId: parsed.sessionId };
}

export function saveMainPaymentRecovery(
  input: { orderId: string; sessionId: string; checkout?: CheckoutProductContext },
  storage: Storage | null = browserStorage(),
  now = Date.now(),
): MainPaymentRecoveryMarker | null {
  const parsed = parseMainPaymentRecoveryOrder(input.orderId);
  if (!parsed || parsed.sessionId !== input.sessionId || !storage) return null;
  const marker: MainPaymentRecoveryMarker = {
    version: 1,
    orderId: parsed.orderId,
    sessionId: parsed.sessionId,
    createdAt: now,
    ...(input.checkout ? { checkout: normalizedCheckout(input.checkout) ?? undefined } : {}),
  };
  try {
    storage.setItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY, JSON.stringify(marker));
    return marker;
  } catch {
    return null;
  }
}

export function readMainPaymentRecovery(
  storage: Storage | null = browserStorage(),
  now = Date.now(),
): MainPaymentRecoveryMarker | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<MainPaymentRecoveryMarker>;
    const parsed = parseMainPaymentRecoveryOrder(value.orderId);
    const checkout = value.checkout === undefined ? undefined : normalizedCheckout(value.checkout);
    const valid =
      value.version === 1 &&
      parsed !== null &&
      value.sessionId === parsed.sessionId &&
      Number.isSafeInteger(value.createdAt) &&
      (value.createdAt as number) <= now &&
      now - (value.createdAt as number) <= MAIN_PAYMENT_RECOVERY_MAX_AGE_MS &&
      (value.checkout === undefined || checkout !== null);
    if (!valid) {
      storage.removeItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY);
      return null;
    }
    return {
      version: 1,
      orderId: parsed.orderId,
      sessionId: parsed.sessionId,
      createdAt: value.createdAt as number,
      ...(checkout ? { checkout } : {}),
    };
  } catch {
    try {
      storage.removeItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY);
    } catch {
      // Storage is best-effort. The signed cookie + query parameter are the
      // server-authoritative recovery path when browser storage is unavailable.
    }
    return null;
  }
}

export function clearMainPaymentRecovery(storage: Storage | null = browserStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(MAIN_PAYMENT_RECOVERY_STORAGE_KEY);
  } catch {
    // Best-effort browser cleanup only.
  }
}
