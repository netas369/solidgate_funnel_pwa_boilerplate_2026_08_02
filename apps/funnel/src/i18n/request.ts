import { getRequestConfig } from 'next-intl/server';
import { routing } from '@repo/i18n/routing';
import { getMessages } from '@repo/i18n/messages';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }

  const messages = await getMessages(locale, [
    'common',
    'quiz',
    'offer',
    'oto',
    'success',
    'legal',
    'auth',
  ]);

  return {
    locale,
    messages,
  };
});
