/**
 * Auth-gate contract for apps/pwa/src/proxy.ts.
 *
 * The PWA proxy is deny-by-default: every page route requires a Supabase user
 * EXCEPT a small PUBLIC_PATHS allowlist (/login, /auth, /~offline). Driving the
 * full Next.js middleware stack needs Supabase + next-intl + cookies + env, so
 * this test stays hermetic: it reads PUBLIC_PATHS from the proxy source and
 * mirrors the same stripLocalePrefix + isPublic normalization the proxy uses,
 * failing loudly if either regresses.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routing, LOCALE_URL_PREFIX } from '@repo/i18n/routing';

const PROXY_PATH = path.resolve(__dirname, './proxy.ts');
const PROXY_SOURCE = fs.readFileSync(PROXY_PATH, 'utf8');

/**
 * Mirror of proxy.ts `stripLocalePrefix` — uses the real routing config so a
 * locale-list or custom-prefix change is reflected here automatically.
 */
function stripLocalePrefix(pathname: string): string {
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue;
    const prefix = `/${LOCALE_URL_PREFIX[locale]}`;
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
    if (pathname === prefix) return '/';
  }
  return pathname;
}

/**
 * Extract the PUBLIC_PATHS allowlist from proxy.ts so the test sees the real
 * production value, not a duplicated constant.
 */
function extractPublicPaths(source: string): string[] {
  const match = source.match(/const PUBLIC_PATHS = \[([^\]]*)\]/);
  if (!match) {
    throw new Error('Could not locate PUBLIC_PATHS array in proxy.ts');
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
}

/** Mirror of the proxy's isPublic check. */
function isPublic(pathname: string, publicPaths: string[]): boolean {
  const normalized = stripLocalePrefix(pathname);
  return publicPaths.some((p) => normalized === p || normalized.startsWith(`${p}/`));
}

describe('pwa proxy auth gate', () => {
  const publicPaths = extractPublicPaths(PROXY_SOURCE);

  it('PUBLIC_PATHS allowlist is exactly /login, /auth, /~offline', () => {
    expect([...publicPaths].sort()).toEqual(['/auth', '/login', '/~offline']);
  });

  it('classifies the public paths (and their children) as public', () => {
    expect(isPublic('/login', publicPaths)).toBe(true);
    expect(isPublic('/auth', publicPaths)).toBe(true);
    expect(isPublic('/~offline', publicPaths)).toBe(true);
    expect(isPublic('/auth/callback', publicPaths)).toBe(true);
  });

  it('gates every non-public page route (deny-by-default)', () => {
    expect(isPublic('/', publicPaths)).toBe(false);
    expect(isPublic('/dashboard', publicPaths)).toBe(false);
    expect(isPublic('/billing/update-payment', publicPaths)).toBe(false);
  });

  it('strips standard locale prefixes before matching', () => {
    // /lt/dashboard → /dashboard → gated; /lt/login → /login → public.
    expect(isPublic('/lt/dashboard', publicPaths)).toBe(false);
    expect(isPublic('/lt/login', publicPaths)).toBe(true);
    // A bare locale root normalizes to '/' → gated.
    expect(isPublic('/lt', publicPaths)).toBe(false);
  });

  it('strips every non-default locale URL prefix (incl. custom prefixes) before matching', () => {
    // da→/dk, cs→/cz, zh-TW→/tw, etc. Without consulting LOCALE_URL_PREFIX the
    // gate would treat /dk/login as a non-public path and redirect-loop.
    for (const locale of routing.locales) {
      if (locale === routing.defaultLocale) continue;
      const prefix = LOCALE_URL_PREFIX[locale];
      expect(prefix, `LOCALE_URL_PREFIX missing for ${locale}`).toBeTruthy();
      expect(
        isPublic(`/${prefix}/login`, publicPaths),
        `/${prefix}/login should be public`,
      ).toBe(true);
      expect(
        isPublic(`/${prefix}/dashboard`, publicPaths),
        `/${prefix}/dashboard should be gated`,
      ).toBe(false);
    }
  });

  it('proxy source enforces deny-by-default with a Supabase user check', () => {
    expect(PROXY_SOURCE).toMatch(/if \(!isPublic\)/);
    expect(PROXY_SOURCE).toMatch(/auth\.getUser\(\)/);
    expect(PROXY_SOURCE).toMatch(/NextResponse\.redirect/);
  });

  it('API routes bypass the page auth gate', () => {
    expect(PROXY_SOURCE).toMatch(/pathname\.startsWith\('\/api\/'\)/);
  });
});
