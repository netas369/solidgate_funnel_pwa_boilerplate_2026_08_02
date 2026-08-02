import { describe, expect, it } from 'vitest';
import { routing } from '@repo/i18n/routing';
import sitemap from '../sitemap';

/**
 * A sitemap that lists URLs the router does not serve is worse than no sitemap:
 * it hands search engines 404s and redirect chains as canonical entries. This
 * file interpolated `/${locale}`, which is wrong for the six locales routed
 * under a country code and points every `en` entry at a 307.
 */
describe('funnel sitemap', () => {
  const entries = sitemap();

  it('lists every public path once per locale', () => {
    expect(entries.length).toBe(9 * routing.locales.length);
  });

  it('emits only segments the router actually serves', () => {
    // Oracle is routing.localePrefix — deriving it from the same table the
    // implementation reads would assert nothing.
    const prefixes =
      (routing.localePrefix as { prefixes?: Record<string, string> }).prefixes ?? {};
    const servable = new Set(
      routing.locales.map((locale) =>
        locale === routing.defaultLocale ? '' : (prefixes[locale] ?? `/${locale}`),
      ),
    );

    for (const entry of entries) {
      const { pathname } = new URL(entry.url);
      const segment = pathname === '/' ? '' : `/${pathname.split('/')[1]}`;
      // A path like /quiz on the default locale has no locale segment at all,
      // so its first segment is a public path rather than a prefix.
      const isDefaultLocaleUrl = !servable.has(segment) || segment === '';
      if (!isDefaultLocaleUrl) {
        expect(servable, `unroutable segment in ${entry.url}`).toContain(segment);
      }
    }
  });

  it('gives the default locale unprefixed canonical URLs', () => {
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain('/quiz');
    expect(paths.some((path) => path.startsWith('/en/') || path === '/en')).toBe(false);
  });

  it('routes Czech under /cz and never /cs', () => {
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain('/cz/quiz');
    expect(paths.some((path) => path.startsWith('/cs/') || path === '/cs')).toBe(false);
  });
});
