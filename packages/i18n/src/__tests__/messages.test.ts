import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { routing } from '../routing';

const MESSAGES_DIR = join(__dirname, '../../messages');
const NAMESPACES = ['common', 'quiz', 'offer', 'oto', 'success', 'legal', 'auth', 'pwa', 'billing'];

const ROUTING_LOCALES = routing.locales as unknown as string[];

/** Locale folders that actually exist on disk. */
const MESSAGE_DIRS = readdirSync(MESSAGES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * The suites below are driven by the folders that EXIST, intersected with the
 * routing locales — not by routing.locales alone.
 *
 * The boilerplate ships only `en`; the other 14 routing locales fall back to
 * English at runtime (see src/messages.ts) and have nothing to compare here.
 * Drop a translated folder in and every parity suite reactivates by itself,
 * with no edit to this file. That self-reactivating property is the point —
 * do not replace it with a hardcoded list.
 */
const PRESENT_LOCALES = MESSAGE_DIRS.filter((dir) => ROUTING_LOCALES.includes(dir));
const PRESENT_NON_EN_LOCALES = PRESENT_LOCALES.filter((l) => l !== routing.defaultLocale);

/** vitest's it.each throws on an empty table; skip cleanly instead. */
function eachPresentNonEn() {
  return PRESENT_NON_EN_LOCALES.length > 0 ? it.each(PRESENT_NON_EN_LOCALES) : it.skip.each(['(none)']);
}

/** Parse one ICU message and collect its unique argument names + format types.
 *  Plural/select branch prose is deliberately ignored: translated messages
 *  need locale-specific categories and wording while preserving the same data
 *  arguments as English. Parsing also makes malformed ICU fail this test. */
function messageArguments(message: string): string[] {
  const result = new Set<string>();
  const visit = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      switch (element.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          result.add(`${element.type}:${element.value}`);
          break;
        case TYPE.select:
        case TYPE.plural:
          result.add(`${element.type}:${element.value}`);
          for (const option of Object.values(element.options)) visit(option.value);
          break;
        case TYPE.tag:
          visit(element.children);
          break;
      }
    }
  };
  visit(parse(message));
  return [...result].sort();
}

/** Recursively extract ICU arguments from all string values. */
function extractTokens(obj: unknown, prefix = ''): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (obj === null || obj === undefined) return result;
  if (typeof obj === 'string') {
    const tokens = messageArguments(obj);
    if (tokens.length > 0) {
      result.set(prefix, tokens);
    }
    return result;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      const sub = extractTokens(item, `${prefix}[${i}]`);
      sub.forEach((v, k) => result.set(k, v));
    });
    return result;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const sub = extractTokens(value, path);
      sub.forEach((v, k) => result.set(k, v));
    }
  }
  return result;
}

/** Recursively extract array lengths at each key path */
function extractArrayLengths(obj: unknown, prefix = ''): Map<string, number> {
  const result = new Map<string, number>();
  if (obj === null || obj === undefined || typeof obj !== 'object') return result;
  if (Array.isArray(obj)) {
    result.set(prefix, obj.length);
    obj.forEach((item, i) => {
      const sub = extractArrayLengths(item, `${prefix}[${i}]`);
      sub.forEach((v, k) => result.set(k, v));
    });
    return result;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const sub = extractArrayLengths(value, path);
    sub.forEach((v, k) => result.set(k, v));
  }
  return result;
}

/** Recursively collect all leaf key paths (skipping _locale and _status metadata) */
function getLeafKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj !== 'object') return [prefix];
  if (Array.isArray(obj)) {
    const keys: string[] = [];
    obj.forEach((item, i) => {
      keys.push(...getLeafKeys(item, `${prefix}[${i}]`));
    });
    return keys;
  }
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '_locale' || key === '_status') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(...getLeafKeys(value, path));
  }
  return keys;
}

/**
 * Long-form legal copy exemption. `legal.documents.*` holds the policy texts
 * (privacy, terms, subscription, money-back, cookies). The English source is
 * the canonical legal copy and is revised independently of translations, so
 * section / paragraph / list counts legitimately differ per locale until each
 * locale is re-translated — structural deep-key / array-length parity is the
 * wrong invariant here. Top-level key and interpolation-token parity still
 * apply. The `documents` subtree only exists in the `legal` namespace.
 *
 * This is the ONLY content exemption. Add another only for a subtree whose
 * paragraph structure is genuinely allowed to differ per locale.
 */
function isLegalDocumentPath(keyPath: string): boolean {
  return keyPath === 'documents' || keyPath.startsWith('documents.') || keyPath.startsWith('documents[');
}

/** Collect every string-leaf value keyed by its path (skips _locale/_status). */
function flattenStrings(obj: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof obj === 'string') {
    if (prefix) out.set(prefix, obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => flattenStrings(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === '_locale' || key === '_status') continue;
      flattenStrings(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

/**
 * A "sentence" is real prose that MUST be localized: after stripping a trailing
 * interpolation token / tag it ends with sentence punctuation and has >= 4
 * alphabetic words. Brand/company/address/identifier values are never sentences,
 * so a non-en value that is byte-identical to EN here is a genuine untranslated
 * leftover — not a legitimate proper-noun keep. This is the QA guard against
 * shipping English prose in a localized file.
 */
function isEnglishSentence(value: string): boolean {
  const trimmed = value.replace(/\s*(\{\{[^}]+\}\}|\{[^}]+\}|<[^>]+>)\s*$/, '').trim();
  if (!/[.!?…]$/.test(trimmed)) return false;
  const words = trimmed
    .replace(/\{\{[^}]+\}\}|\{[^}]+\}|<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(w => /[A-Za-z]{2,}/.test(w));
  return words.length >= 4;
}

describe('i18n message files', () => {
  // The default locale is the parity SOURCE — every other suite compares
  // against it, so its absence must fail loudly rather than silently disable
  // the whole file.
  it('the defaultLocale directory exists', () => {
    expect(existsSync(join(MESSAGES_DIR, routing.defaultLocale))).toBe(true);
  });

  // A folder that is not a routing locale is dead weight nothing can ever
  // serve: either add it to routing.locales or delete it.
  it.each(MESSAGE_DIRS)('messages directory "%s" is a routing locale', (dir) => {
    expect(ROUTING_LOCALES).toContain(dir);
  });

  it('has at least one usable messages directory', () => {
    expect(PRESENT_LOCALES.length).toBeGreaterThan(0);
  });

  it.each(PRESENT_LOCALES)('locale "%s" has all namespace files', (locale) => {
    const dir = join(MESSAGES_DIR, locale);
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    for (const ns of NAMESPACES) {
      expect(files).toContain(ns);
    }
  });

  // ICU validity of the SOURCE strings — this one runs even with a single
  // locale present, because messageArguments() throws on malformed ICU.
  it.each(PRESENT_LOCALES)('locale "%s" has parseable ICU in every namespace', (locale) => {
    for (const ns of NAMESPACES) {
      const content = JSON.parse(readFileSync(join(MESSAGES_DIR, locale, `${ns}.json`), 'utf8'));
      expect(() => extractTokens(content)).not.toThrow();
    }
  });

  eachPresentNonEn()('locale "%s" files have _locale metadata and valid _status', (locale) => {
    for (const ns of NAMESPACES) {
      const filePath = join(MESSAGES_DIR, locale, `${ns}.json`);
      const content = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content._locale).toBe(locale);
      expect(
        content._status === 'translated' || content._status.includes('stub')
      ).toBe(true);
    }
  });

  eachPresentNonEn()('locale "%s" has top-level key parity with en', (locale) => {
    for (const ns of NAMESPACES) {
      const enPath = join(MESSAGES_DIR, 'en', `${ns}.json`);
      const localePath = join(MESSAGES_DIR, locale, `${ns}.json`);
      const enKeys = Object.keys(JSON.parse(readFileSync(enPath, 'utf8')));
      const localeKeys = Object.keys(JSON.parse(readFileSync(localePath, 'utf8')));
      for (const key of enKeys) {
        expect(localeKeys).toContain(key);
      }
    }
  });

  eachPresentNonEn()('locale "%s" has interpolation variable parity with en', (locale) => {
    for (const ns of NAMESPACES) {
      const enPath = join(MESSAGES_DIR, 'en', `${ns}.json`);
      const localePath = join(MESSAGES_DIR, locale, `${ns}.json`);
      const enContent = JSON.parse(readFileSync(enPath, 'utf8'));
      const localeContent = JSON.parse(readFileSync(localePath, 'utf8'));
      const enTokens = extractTokens(enContent);
      const localeTokens = extractTokens(localeContent);

      for (const [keyPath, enTokenList] of enTokens) {
        const localeTokenList = localeTokens.get(keyPath);
        expect(localeTokenList, `Missing interpolation tokens at "${ns}.${keyPath}" for locale "${locale}"`).toBeDefined();
        expect(localeTokenList, `Token mismatch at "${ns}.${keyPath}" for locale "${locale}": expected ${JSON.stringify(enTokenList)}`).toEqual(enTokenList);
      }
    }
  });

  eachPresentNonEn()('locale "%s" has array length parity with en', (locale) => {
    for (const ns of NAMESPACES) {
      const enPath = join(MESSAGES_DIR, 'en', `${ns}.json`);
      const localePath = join(MESSAGES_DIR, locale, `${ns}.json`);
      const enContent = JSON.parse(readFileSync(enPath, 'utf8'));
      const localeContent = JSON.parse(readFileSync(localePath, 'utf8'));
      const enArrays = extractArrayLengths(enContent);
      const localeArrays = extractArrayLengths(localeContent);

      for (const [keyPath, enLength] of enArrays) {
        if (isLegalDocumentPath(keyPath)) continue;
        const localeLength = localeArrays.get(keyPath);
        expect(localeLength, `Missing array at "${ns}.${keyPath}" for locale "${locale}"`).toBeDefined();
        expect(localeLength, `Array length mismatch at "${ns}.${keyPath}" for locale "${locale}": expected ${enLength}, got ${localeLength}`).toBe(enLength);
      }
    }
  });

  eachPresentNonEn()('locale "%s" has deep key parity with en', (locale) => {
    for (const ns of NAMESPACES) {
      const enPath = join(MESSAGES_DIR, 'en', `${ns}.json`);
      const localePath = join(MESSAGES_DIR, locale, `${ns}.json`);
      const enContent = JSON.parse(readFileSync(enPath, 'utf8'));
      const localeContent = JSON.parse(readFileSync(localePath, 'utf8'));
      const enLeafKeys = getLeafKeys(enContent);
      const localeLeafKeys = getLeafKeys(localeContent);

      for (const key of enLeafKeys) {
        if (isLegalDocumentPath(key)) continue;
        expect(localeLeafKeys, `Missing deep key "${ns}.${key}" for locale "${locale}"`).toContain(key);
      }
    }
  });

  // QA gate: no English prose left untranslated. An EN sentence that survives
  // byte-identical into a non-en file is an untranslated leftover (proper nouns,
  // brand names and addresses are never sentences, so they don't trip this).
  eachPresentNonEn()('locale "%s" has no untranslated English sentences', (locale) => {
    for (const ns of NAMESPACES) {
      const enContent = JSON.parse(readFileSync(join(MESSAGES_DIR, 'en', `${ns}.json`), 'utf8'));
      const localeContent = JSON.parse(readFileSync(join(MESSAGES_DIR, locale, `${ns}.json`), 'utf8'));
      const enStrings = flattenStrings(enContent);
      const localeStrings = flattenStrings(localeContent);

      for (const [keyPath, enValue] of enStrings) {
        if (isLegalDocumentPath(keyPath)) continue;
        if (!isEnglishSentence(enValue)) continue;
        const localeValue = localeStrings.get(keyPath);
        expect(
          localeValue,
          `Untranslated English sentence at "${ns}.${keyPath}" for locale "${locale}": "${enValue.slice(0, 60)}"`,
        ).not.toBe(enValue);
      }
    }
  });
});
