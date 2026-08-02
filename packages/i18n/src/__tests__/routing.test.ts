import { describe, it, expect } from 'vitest';
import { getLocaleDir, localePathSegment, routing } from '../routing';

const EXPECTED_LOCALES = ['en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el', 'he', 'pl', 'hr', 'da', 'ja'];

describe('i18n routing config', () => {
  it('has exactly 15 locales', () => {
    expect(routing.locales).toHaveLength(EXPECTED_LOCALES.length);
  });

  it.each(EXPECTED_LOCALES)('includes locale "%s"', (locale) => {
    expect(routing.locales).toContain(locale);
  });

  it('uses "en" as defaultLocale', () => {
    expect(routing.defaultLocale).toBe('en');
  });

  it('uses "as-needed" locale prefix', () => {
    expect(routing.localePrefix).toEqual({
      mode: 'as-needed',
      prefixes: {
        cs: '/cz',
        da: '/dk',
        'zh-TW': '/tw',
        el: '/gr',
        he: '/il',
        ja: '/jp',
      },
    });
  });

  describe('localePathSegment', () => {
    it('returns an empty segment for the unprefixed default locale', () => {
      expect(localePathSegment('en')).toBe('');
    });

    it('uses the country-code prefix, not the locale id, where they differ', () => {
      expect(localePathSegment('cs')).toBe('/cz');
      expect(localePathSegment('da')).toBe('/dk');
      expect(localePathSegment('zh-TW')).toBe('/tw');
      expect(localePathSegment('el')).toBe('/gr');
      expect(localePathSegment('he')).toBe('/il');
      expect(localePathSegment('ja')).toBe('/jp');
    });

    /**
     * The invariant that matters: every segment this produces must be one the
     * router actually serves. A payment return URL built from a segment no
     * route matches renders a 404 inside the payment iframe and strips the
     * order id that grants the purchase.
     *
     * The oracle is `routing.localePrefix` — what next-intl actually serves —
     * NOT LOCALE_URL_PREFIX, which is the table under test. Deriving the
     * expectation from that table would only assert f(x) === f(x): an earlier
     * version of this test did exactly that and passed while the table said
     * Polish routed at `/pll`.
     */
    it('emits a segment the router actually serves, for every locale', () => {
      const prefixes =
        (routing.localePrefix as { prefixes?: Record<string, string> }).prefixes ?? {};
      for (const locale of routing.locales) {
        // next-intl serves an override when one is configured, otherwise the
        // locale id itself; the default locale is unprefixed under 'as-needed'.
        const routable = prefixes[locale] ?? `/${locale}`;
        expect(localePathSegment(locale), `locale ${locale}`).toBe(
          locale === routing.defaultLocale ? '' : routable,
        );
      }
    });
  });

  it('sets Hebrew as RTL and all other supported locales as LTR', () => {
    expect(getLocaleDir('he')).toBe('rtl');

    for (const locale of EXPECTED_LOCALES.filter((item) => item !== 'he')) {
      expect(getLocaleDir(locale)).toBe('ltr');
    }
  });
});
