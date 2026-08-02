import { getRequestConfig } from 'next-intl/server';
import { routing, type Locale } from '@repo/i18n/routing';
import { getMessages } from '@repo/i18n/messages';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  // Fail safe, not closed: an unknown segment falls back to the default locale
  // rather than throwing, so a stale bookmark renders instead of 500-ing.
  if (!locale || !(routing.locales as readonly string[]).includes(locale)) {
    locale = routing.defaultLocale;
  }

  const messages = await getMessages(locale as Locale, ['common', 'pwa', 'auth', 'billing']);

  return {
    locale,
    messages,
  };
});
