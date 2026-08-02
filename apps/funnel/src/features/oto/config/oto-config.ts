import type { Currency, ProductId } from '@repo/shared/price-map';
import { ADDON_TRIAL_INTRO_AMOUNTS } from '@repo/shared/solidgate/catalog';

/**
 * The eight OTO slots, as data.
 *
 * Slots 1..7 are charge pages, all rendered by ONE component
 * (`features/oto/components/oto-template.tsx`). Slot 8 is the terminal summary
 * page and deliberately has no entry here — it never charges.
 *
 * ─── HARD NAMING RULES (breaking these silently breaks payments) ────────────
 *
 * 1. Every `productId` MUST be named `oto<step>_<something>` with `<step>`
 *    matching the slot it lives in. `use-solidgate-oto-resume.ts` derives the
 *    step from the regex /^oto([1-7])_/ on the slug and refuses to finalise a
 *    3DS return whose requested and resolved steps disagree
 *    ('binding_mismatch') — a buyer who completed a challenge would be stranded.
 *
 * 2. Every `productId` MUST exist in three other places or the charge fails,
 *    in two cases SILENTLY:
 *      - `PRICE_MAP` in @repo/shared/price-map          (type error if missing)
 *      - the server allowlist + OTO_STEP_BY_PRODUCT in
 *        `app/api/solidgate/charge-oto/route.ts`        (4xx at charge time)
 *      - `ACCEPTED_OTO_PRODUCTS` in `../lib/accepted-oto-recovery.ts`
 *        — derived from THIS file, so it can no longer drift. A missing slug
 *        there does not error: it downgrades a 202-accepted charge to plain
 *        'pending' and drops it from the OTO8 exit sweep, so the buyer walks
 *        away believing they bought something nobody is reconciling.
 *
 * TODO(new product): replace the copy keys, prices and option sets below.
 * The mechanics (gating, recovery, 3DS, progress) are product-agnostic and
 * should not need edits.
 */

/** Mirrors `OtoCurrentStep` in ../lib/advance-oto (kept local to avoid a cycle). */
export type OtoStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OtoOptionConfig {
  /** Local radio-selection key; also the i18n suffix under `items.*`. */
  id: string;
  /** Authoritative PRICE_MAP key — see the naming rules above. */
  productId: ProductId;
  /**
   * Optional strike-through anchor: the displayed "regular" price is
   * `resolveProductPrice(productId).amountCents * compareAtRatio`. Purely a
   * display device — it never changes what is charged.
   */
  compareAtRatio?: number;
}

export interface OtoPageConfig {
  /** Drives advanceOtoBeforeNavigation + resolveOtoNavigationTarget. */
  step: OtoStep;
  /** Message namespace, e.g. 'oto.oto1'. */
  i18nNamespace: string;
  /** length 1 = single product; > 1 = radio list (OTO3 keeps this pattern). */
  options: readonly OtoOptionConfig[];
  /** Which option is preselected; defaults to `options[0].id`. */
  defaultOptionId?: string;
  events: { viewed: string; purchased: string; declined: string };
  /**
   * 'session'            — a sessionId is enough (slots 3..7).
   * 'session+authorized' — also requires a completed quiz OR a purchase-granted
   *                        session (slots 1 & 2, which sit right behind the
   *                        main checkout).
   */
  gate: 'session' | 'session+authorized';
  /** Slot 1 only: gate the buy CTA on /api/solidgate/pm-info reporting a card. */
  requiresSavedCard?: boolean;
  /** Slot 1 only: watch ?sg_main for the main checkout's settlement. */
  watchesMainPayment?: boolean;
  /** A second price rendered as a comparison anchor (not charged). */
  anchorProductId?: ProductId;
  /**
   * Subscription slots whose quoted FIRST charge differs from PRICE_MAP
   * (PRICE_MAP holds the recurring amount). Must equal the trial_price the
   * PSP actually settles when the subscription starts.
   */
  introAmounts?: Readonly<Record<Currency, number>>;
  /** Where /preview walks to when buy or skip is pressed. */
  previewNext: string;
}

export const OTO_CONFIG: Readonly<Record<OtoStep, OtoPageConfig>> = {
  1: {
    step: 1,
    i18nNamespace: 'oto.oto1',
    options: [{ id: 'main', productId: 'oto1_lifetime' }],
    events: { viewed: 'oto1_viewed', purchased: 'oto1_purchased', declined: 'oto1_declined' },
    gate: 'session+authorized',
    requiresSavedCard: true,
    watchesMainPayment: true,
    anchorProductId: 'trial_monthly',
    previewNext: '/preview/oto/2',
  },
  2: {
    step: 2,
    i18nNamespace: 'oto.oto2',
    options: [{ id: 'main', productId: 'oto2_addon_weekly' }],
    events: { viewed: 'oto2_viewed', purchased: 'oto2_purchased', declined: 'oto2_declined' },
    gate: 'session+authorized',
    // The quoted first charge is the add-on's intro amount, not its rebill.
    introAmounts: ADDON_TRIAL_INTRO_AMOUNTS,
    previewNext: '/preview/oto/3',
  },
  3: {
    step: 3,
    i18nNamespace: 'oto.oto3',
    // The multi-option slot. The SELECTED option's productId feeds both
    // chargeOtoSolidgate and useSolidgateOtoResume — they must never diverge.
    options: [
      { id: 'bundleAll', productId: 'oto3_bundle_all', compareAtRatio: 3 },
      { id: 'bundle1', productId: 'oto3_bundle_1', compareAtRatio: 2 },
      { id: 'bundle2', productId: 'oto3_bundle_2', compareAtRatio: 2 },
      { id: 'bundle3', productId: 'oto3_bundle_3', compareAtRatio: 2 },
    ],
    defaultOptionId: 'bundleAll',
    events: { viewed: 'oto3_viewed', purchased: 'oto3_purchased', declined: 'oto3_declined' },
    gate: 'session',
    previewNext: '/preview/oto/4',
  },
  4: {
    step: 4,
    i18nNamespace: 'oto.oto4',
    options: [{ id: 'main', productId: 'oto4_pdf', compareAtRatio: 3 }],
    events: { viewed: 'oto4_viewed', purchased: 'oto4_purchased', declined: 'oto4_declined' },
    gate: 'session',
    previewNext: '/preview/oto/5',
  },
  5: {
    step: 5,
    i18nNamespace: 'oto.oto5',
    options: [{ id: 'main', productId: 'oto5_pdf', compareAtRatio: 3 }],
    events: { viewed: 'oto5_viewed', purchased: 'oto5_purchased', declined: 'oto5_declined' },
    gate: 'session',
    previewNext: '/preview/oto/6',
  },
  6: {
    step: 6,
    i18nNamespace: 'oto.oto6',
    options: [{ id: 'main', productId: 'oto6_pdf', compareAtRatio: 3 }],
    events: { viewed: 'oto6_viewed', purchased: 'oto6_purchased', declined: 'oto6_declined' },
    gate: 'session',
    previewNext: '/preview/oto/7',
  },
  7: {
    step: 7,
    i18nNamespace: 'oto.oto7',
    options: [{ id: 'main', productId: 'oto7_pdf', compareAtRatio: 3 }],
    events: { viewed: 'oto7_viewed', purchased: 'oto7_purchased', declined: 'oto7_declined' },
    gate: 'session',
    previewNext: '/preview/oto/8',
  },
} as const;

export const OTO_STEPS: readonly OtoStep[] = [1, 2, 3, 4, 5, 6, 7];

/** Every chargeable OTO product id, in slot order. Single source of truth. */
export const OTO_PRODUCT_IDS: readonly ProductId[] = OTO_STEPS.flatMap((step) =>
  OTO_CONFIG[step].options.map((option) => option.productId),
);
