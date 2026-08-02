import type { Locale } from './routing';
import { routing } from './routing';

export type Namespace =
  | 'common' | 'quiz' | 'offer' | 'oto' | 'success'
  | 'legal' | 'auth' | 'pwa' | 'billing';

type NsImporter = () => Promise<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// The boilerplate ships ONE message folder: `messages/en`.
//
// routing.ts still declares all 15 locales, and that is deliberate — the
// as-needed prefixing, the country-code overrides and the RTL handling are
// infrastructure worth keeping alive. Any locale without its own folder simply
// renders the English strings (see getMessages below); it must NEVER throw,
// because a 500 on /lt/offer would take a whole market offline for a missing
// translation.
//
// TO RE-ADD A LOCALE — 2 steps, no other file changes:
//   1. Create `packages/i18n/messages/<locale>/` with all 9 namespace JSON
//      files (each carrying `"_locale": "<locale>"` and a `"_status"` of
//      "translated" or something containing "stub").
//   2. Paste one block into `messageImports` below, e.g. for `lt`:
//
//        lt: {
//          common:  () => import('../messages/lt/common.json'),
//          quiz:    () => import('../messages/lt/quiz.json'),
//          offer:   () => import('../messages/lt/offer.json'),
//          oto:     () => import('../messages/lt/oto.json'),
//          success: () => import('../messages/lt/success.json'),
//          legal:   () => import('../messages/lt/legal.json'),
//          auth:    () => import('../messages/lt/auth.json'),
//          pwa:     () => import('../messages/lt/pwa.json'),
//          billing: () => import('../messages/lt/billing.json'),
//        },
//
// The import paths are static string literals on purpose: bundlers must be able
// to see every message file at build time. A computed `import(\`../messages/
// ${locale}/${ns}.json\`)` looks tidier but makes Next/Turbopack bundle the
// whole directory (or fail), which is why this table exists at all.
//
// The parity suites in `__tests__/messages.test.ts` reactivate automatically as
// soon as the folder exists — no test edits needed.
// ─────────────────────────────────────────────────────────────────────────────

const messageImports: Partial<Record<Locale, Record<Namespace, NsImporter>>> = {
  en: {
    common: () => import('../messages/en/common.json'),
    quiz: () => import('../messages/en/quiz.json'),
    offer: () => import('../messages/en/offer.json'),
    oto: () => import('../messages/en/oto.json'),
    success: () => import('../messages/en/success.json'),
    legal: () => import('../messages/en/legal.json'),
    auth: () => import('../messages/en/auth.json'),
    pwa: () => import('../messages/en/pwa.json'),
    billing: () => import('../messages/en/billing.json'),
  },
};

const FALLBACK_LOCALE = routing.defaultLocale as Locale;

/** Warn once per locale, not once per request — this runs on every render. */
const warnedLocales = new Set<string>();

function warnFallbackOnce(locale: string): void {
  if (warnedLocales.has(locale)) return;
  warnedLocales.add(locale);
  console.warn(
    `[i18n] No message folder for locale "${locale}" — falling back to ` +
      `"${FALLBACK_LOCALE}". Add packages/i18n/messages/${locale}/ and an ` +
      `import block in packages/i18n/src/messages.ts to translate it.`,
  );
}

export async function getMessages(
  locale: string,
  namespaces: Namespace[]
): Promise<Record<string, Record<string, unknown>>> {
  const typedLocale = locale as Locale;
  let localeImports = messageImports[typedLocale];

  if (!localeImports) {
    // Fall back rather than throw: an untranslated routing locale must still
    // render (in English) instead of 500ing.
    warnFallbackOnce(locale);
    localeImports = messageImports[FALLBACK_LOCALE];
  }

  const messages: Record<string, Record<string, unknown>> = {};
  if (!localeImports) return messages;

  for (const ns of namespaces) {
    const importFn = localeImports[ns];
    if (importFn) {
      const mod = await importFn();
      messages[ns] = (mod as { default?: Record<string, unknown> }).default ?? (mod as Record<string, unknown>);
    } else {
      console.warn(`[i18n] Missing namespace "${ns}" for locale "${locale}"`);
    }
  }

  return messages;
}
