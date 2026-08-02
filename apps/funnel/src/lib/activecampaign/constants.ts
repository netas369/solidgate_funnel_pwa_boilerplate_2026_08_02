// ActiveCampaign list/tag NAMES.
//
// There are no numeric list or tag IDs anywhere in this integration. IDs are
// resolved at runtime by EXACT-name match against AC's /lists and /tags
// endpoints and cached in-module (see client.ts) — so the names below are the
// entire contract with your AC account. Create lists/tags with these names, or
// change the grammar here to match what you already have.
//
// The whole integration is inert until ACTIVECAMPAIGN_API_URL and
// ACTIVECAMPAIGN_API_KEY are set, so it costs nothing to ship unconfigured.

import { LOCALE_COMPANY_PREFIXES } from '@repo/shared/locale-prefixes';
import type { LocalePrefix } from '@repo/shared/locale-prefixes';
import { PRICE_BATCH, PRODUCT_CODE_PREFIX } from '@repo/shared/price-map';

export { LOCALE_COMPANY_PREFIXES } from '@repo/shared/locale-prefixes';
export type { LocalePrefix } from '@repo/shared/locale-prefixes';

/**
 * Fallback locale prefix. getAcLocalePrefix() used to THROW on an unknown
 * locale, which surfaced inside the fulfillment outbox as a job that retried
 * forever. A CRM label is not worth failing a purchase over.
 */
const DEFAULT_LOCALE_PREFIX: LocalePrefix = LOCALE_COMPANY_PREFIXES.en;

/** Resolve a next-intl locale to the AC-compatible prefix. */
export function getAcLocalePrefix(locale: string): LocalePrefix {
  const prefix = (LOCALE_COMPANY_PREFIXES as Record<string, LocalePrefix | undefined>)[
    locale
  ];
  if (!prefix) {
    console.warn(`[activecampaign] unknown locale "${locale}", using default prefix`);
    return DEFAULT_LOCALE_PREFIX;
  }
  return prefix;
}

/**
 * The campaign segment of every list/tag name.
 *
 * Defaults to the same `{PREFIX}_{BATCH}` grammar the Solidgate catalog and the
 * price map use, so CRM segments line up with product codes without a second
 * naming scheme to maintain. Override with AC_CAMPAIGN_CODE when your AC
 * account already uses different names.
 */
export const AC_CAMPAIGN_CODE =
  process.env.AC_CAMPAIGN_CODE ?? `${PRODUCT_CODE_PREFIX}_${PRICE_BATCH}`;

/** Email-capture list: `{LOCALE}_{CAMPAIGN}_SUB_EMAIL`. */
export function getEmailListName(prefix: LocalePrefix): string {
  return `${prefix}_${AC_CAMPAIGN_CODE}_SUB_EMAIL`;
}

/** Subscriber list (post-purchase): `{LOCALE}_{CAMPAIGN}_SUB`. */
export function getSubscriberListName(prefix: LocalePrefix): string {
  return `${prefix}_${AC_CAMPAIGN_CODE}_SUB`;
}

/**
 * Buyer tag: `#{LOCALE}_{CAMPAIGN}_SUB`.
 *
 * The leading `#` IS part of the tag name in AC here — it is what keeps buyer
 * tags visually grouped in the AC UI, and the resolver matches exactly.
 */
export function getBuyerTagName(prefix: LocalePrefix): string {
  return `#${prefix}_${AC_CAMPAIGN_CODE}_SUB`;
}

/**
 * Broad per-locale customer tag: `#{LOCALE} customers`.
 *
 * Generated rather than enumerated, so adding a locale to
 * LOCALE_COMPANY_PREFIXES is the only edit needed.
 */
export function getCustomerTagName(prefix: LocalePrefix): string {
  return `#${prefix} customers`;
}

/**
 * Main-plan tier slugs that trigger AC buyer tagging on the initial purchase.
 *
 * NOTE: detection in the Solidgate webhook keys off the order's product CODE
 * (the main offering code), so this constant documents intent rather than
 * acting as a live filter. Every slug listed here rolls up to the same main
 * product and therefore receives buyer tagging on the subscription's first
 * real charge — including the abandonment-recovery tiers, so those buyers are
 * also moved off the email list.
 *
 * TODO(new product): keep in sync with your checkout tiers.
 */
export const AC_MAIN_PLAN_SLUGS = [
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
  'special_free',
] as const;
