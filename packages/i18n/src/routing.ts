import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el', 'he', 'pl', 'hr', 'da', 'ja'],
  defaultLocale: 'en',
  localePrefix: {
    mode: 'as-needed',
    prefixes: {
      cs: '/cz',
      da: '/dk',
      'zh-TW': '/tw',
      el: '/gr',
      he: '/il',
      ja: '/jp',
    },
  },
});

export type Locale = (typeof routing.locales)[number];

const RTL_LOCALES = new Set<Locale>(['he']);

export function getLocaleDir(locale: string | Locale): 'ltr' | 'rtl' {
  return RTL_LOCALES.has(locale as Locale) ? 'rtl' : 'ltr';
}

/**
 * URL prefix for each non-default locale (without leading slash).
 * Most locales use their identifier; a few use ISO country codes.
 */
export const LOCALE_URL_PREFIX: Record<Locale, string> = {
  en: 'en',
  cs: 'cz',
  da: 'dk',
  'zh-TW': 'tw',
  el: 'gr',
  he: 'il',
  hu: 'hu',
  sk: 'sk',
  ro: 'ro',
  lt: 'lt',
  ru: 'ru',
  lv: 'lv',
  pl: 'pl',
  hr: 'hr',
  ja: 'jp',
};

/**
 * Routable path segment for a locale — NOT the locale identifier.
 *
 * Six locales route under a country code rather than their language code, and
 * `as-needed` leaves the default locale unprefixed, so anything that builds a
 * URL from `/${locale}` is wrong for seven of the fifteen. That bites hardest
 * on payment return URLs: the path is handed to the PSP and loads inside the
 * payment iframe, so a segment matching no route renders our 404 where the card
 * form was, and the order id never reaches the code that grants the purchase.
 *
 * Returns '' for the default locale, so callers concatenate rather than join:
 *   `${origin}${localePathSegment(locale)}/offer/details`
 */
export function localePathSegment(locale: Locale): string {
  return locale === routing.defaultLocale ? '' : `/${LOCALE_URL_PREFIX[locale]}`;
}
