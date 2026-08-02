// The canonical main-plan tier vocabulary, DERIVED from the shared catalog.
//
// Four independent payment gates used to hand-maintain their own copy of this
// list (proxy.ts, lib/payment/solidgate-access.ts, api/solidgate/grant and
// api/session/read). Renaming a tier in the price map while missing one of them
// fails CLOSED and silently: solidgate-access starts answering 409
// 'no_saved_card' for every OTO charge, and proxy.ts redirects paid buyers back
// to /offer. Nothing throws, nothing logs. Derive once, import everywhere.

import { PRICE_MAP, type ProductId } from '@repo/shared/price-map';
import {
  PRODUCT_ID_TO_CODE,
  SOLIDGATE_PRODUCT_CODES,
} from '@repo/shared/solidgate/catalog';

/**
 * The one offering that is billed recurringly. Every intro tier converts into
 * it, so it shares their catalog code but is never itself opened at checkout.
 *
 * TODO(new product): repoint if your recurring plan gets a different id.
 */
export const MAIN_RECURRING_PRODUCT_ID: ProductId = 'trial_monthly';

/** Every offering that resolves to the main subscription's catalog product. */
export const MAIN_PLAN_PRODUCT_IDS: readonly ProductId[] = (
  Object.keys(PRODUCT_ID_TO_CODE) as ProductId[]
).filter((id) => PRODUCT_ID_TO_CODE[id] === SOLIDGATE_PRODUCT_CODES.main);

/** The intro tiers a buyer can actually open a checkout on. */
export const MAIN_CHECKOUT_TIER_IDS: readonly ProductId[] = MAIN_PLAN_PRODUCT_IDS.filter(
  (id) => id !== MAIN_RECURRING_PRODUCT_ID,
);

/**
 * Intro tiers that take real money at checkout. A zero-amount tier only
 * authorizes the card (auth_0_amount), which is why the "already paid" lockout
 * in proxy.ts must not count it.
 */
export const PAID_MAIN_CHECKOUT_TIER_IDS: readonly ProductId[] =
  MAIN_CHECKOUT_TIER_IDS.filter((id) =>
    Object.values(PRICE_MAP[id]).some((entry) => entry.amountCents > 0),
  );

/** Set form — every offering on the main plan, including the recurring rebill. */
export const MAIN_PLAN_SLUGS: ReadonlySet<string> = new Set<string>(MAIN_PLAN_PRODUCT_IDS);

/** Set form — the openable intro tiers. */
export const MAIN_CHECKOUT_TIER_SLUGS: ReadonlySet<string> = new Set<string>(
  MAIN_CHECKOUT_TIER_IDS,
);

/** Set form — the intro tiers that collect money. */
export const PAID_MAIN_CHECKOUT_TIER_SLUGS: ReadonlySet<string> = new Set<string>(
  PAID_MAIN_CHECKOUT_TIER_IDS,
);
