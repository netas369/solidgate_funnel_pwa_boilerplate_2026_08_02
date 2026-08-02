import { describe, expect, it } from 'vitest';
import { routing } from '../../../../packages/i18n/src/routing.ts';
import {
  WELCOME_EMAIL_COPY as SHARED_WELCOME_EMAIL_COPY,
} from '../../../../packages/shared/src/email/send-welcome-email.ts';
import {
  getWelcomeEmailCopy,
  getWelcomeEmailDir,
  normalizeWelcomeLocale,
  WELCOME_EMAIL_COPY,
  WELCOME_LOCALES,
  type WelcomeEmailCopy,
} from '../_welcome_email.ts';

const REQUIRED_KEYS: Array<keyof WelcomeEmailCopy> = [
  'subject',
  'eyebrow',
  'title',
  'greeting',
  'body',
  'buttonLabel',
  'signInNote',
  'footerTagline',
  'footerAuto',
];

describe('welcome email localized copy', () => {
  it('only claims locales the router actually serves', () => {
    // The boilerplate ships English copy only. Every locale it DOES claim must
    // be a real routing locale — the reverse is deliberately not required, so
    // adding a routing locale never breaks the purchase flow before its copy
    // has been translated.
    for (const locale of WELCOME_LOCALES) {
      expect(routing.locales, locale).toContain(locale);
    }
    expect(Object.keys(WELCOME_EMAIL_COPY).sort()).toEqual([...WELCOME_LOCALES].sort());
  });

  it('keeps the shared and webhook copy in sync', () => {
    // Two copies of this table exist because the edge function runs on Deno and
    // cannot import from packages/shared. Nothing but this test stops them
    // drifting, and a drifted welcome email is invisible until a buyer
    // complains.
    expect(SHARED_WELCOME_EMAIL_COPY).toEqual(WELCOME_EMAIL_COPY);
  });

  it('has complete non-empty copy for every locale', () => {
    for (const locale of WELCOME_LOCALES) {
      const copy = WELCOME_EMAIL_COPY[locale];
      for (const key of REQUIRED_KEYS) {
        expect(copy[key].trim(), `${locale}.${key}`).not.toBe('');
      }
    }
  });

  it('keeps required interpolation placeholders intact', () => {
    for (const locale of WELCOME_LOCALES) {
      const copy = WELCOME_EMAIL_COPY[locale];
      expect(copy.subject, `${locale}.subject`).toContain('{brand}');
      expect(copy.greeting, `${locale}.greeting`).toContain('{brand}');
      expect(copy.body, `${locale}.body`).toContain('{email}');
      expect(copy.signInNote, `${locale}.signInNote`).toContain('{email}');
      expect(copy.footerTagline, `${locale}.footerTagline`).toContain('{brand}');
      expect(copy.footerAuto, `${locale}.footerAuto`).toContain('{host}');
    }
  });

  it('uses an unambiguous action for accessing an existing account', () => {
    // "Access your account", never "Create your account": the account already
    // exists at this point and a create-flavoured CTA sends buyers to signup.
    expect(WELCOME_EMAIL_COPY.en.buttonLabel).toBe('Access your account');
  });

  it('falls back to English and still lays out RTL locales right-to-left', () => {
    expect(normalizeWelcomeLocale('fr')).toBe('en');
    expect(getWelcomeEmailCopy('fr')).toBe(WELCOME_EMAIL_COPY.en);
    // Direction is resolved from the requested locale, not the fallback copy.
    expect(getWelcomeEmailDir('he')).toBe('rtl');
    expect(getWelcomeEmailDir('en')).toBe('ltr');
  });
});
