import { NextResponse, NextRequest } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing, LOCALE_URL_PREFIX } from '@repo/i18n/routing';
import { updateSession } from '@repo/shared/supabase/middleware';

const intlMiddleware = createIntlMiddleware(routing);

/**
 * Map Vercel's x-vercel-ip-country header to a supported locale.
 * Only used when the user has not explicitly chosen a locale (no NEXT_LOCALE cookie).
 */
const COUNTRY_LOCALE_MAP: Record<string, string> = {
  // Lithuanian
  LT: 'lt',
  // Czech
  CZ: 'cs',
  // Greek
  GR: 'el',
  CY: 'el',
  // Croatian
  HR: 'hr',
  BA: 'hr',
  // Latvian
  LV: 'lv',
  // Russian-speaking countries
  RU: 'ru',
  BY: 'ru',
  KZ: 'ru',
  KG: 'ru',
  TJ: 'ru',
  UZ: 'ru',
  TM: 'ru',
  UA: 'ru',
  // Chinese Traditional
  TW: 'zh-TW',
  HK: 'zh-TW',
  MO: 'zh-TW',
  // Hungarian
  HU: 'hu',
  // Slovak
  SK: 'sk',
  // Romanian (Moldova's official language is Romanian  -  overrides earlier Russian mapping)
  RO: 'ro',
  MD: 'ro',
  // Hebrew
  IL: 'he',
  // Polish
  PL: 'pl',
  // Danish
  DK: 'da',
};

/**
 * Strip locale prefix from pathname for route matching.
 * With as-needed prefix, default locale (en) has no prefix,
 * so /dashboard stays /dashboard; /lt/dashboard becomes /dashboard.
 */
function stripLocalePrefix(pathname: string): string {
  // Some locales use a custom URL prefix that differs from the locale code
  // (e.g. da → /dk, cs → /cz, zh-TW → /tw, el → /gr, he → /il). The intl
  // routing config holds these in routing.localePrefix.prefixes  -  without
  // consulting it the proxy auth gate sees `/dk/login` as a non-public path
  // and ping-pongs into a redirect loop.
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue;
    const prefix = `/${LOCALE_URL_PREFIX[locale]}`;
    if (pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length);
    }
    if (pathname === prefix) {
      return '/';
    }
  }
  return pathname;
}

/**
 * Resolve the current locale from the pathname.
 * Returns non-default locale if prefixed, otherwise default.
 */
function resolveLocale(pathname: string): string {
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue;
    const prefix = `/${LOCALE_URL_PREFIX[locale]}`;
    if (pathname.startsWith(`${prefix}/`) || pathname === prefix) {
      return locale;
    }
  }
  return routing.defaultLocale;
}

/**
 * Build a locale-aware path. For default locale, returns bare path.
 * For other locales, prefixes with /{locale}.
 */
function localePath(path: string, locale: string): string {
  if (locale === routing.defaultLocale) return path;
  const localeKey = locale as keyof typeof LOCALE_URL_PREFIX;
  const prefix = LOCALE_URL_PREFIX[localeKey] ?? locale;
  return `/${prefix}${path}`;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- API routes: skip i18n middleware, run auth logic only ---
  if (pathname.startsWith('/api/')) {
    return updateSession(request);
  }

  // --- Geo-detection: Vercel injects x-vercel-ip-country header ---
  // Only use geo if user hasn't explicitly chosen a locale (no NEXT_LOCALE cookie).
  // This is a SECONDARY signal. Accept-Language is primary. NEXT_LOCALE cookie overrides both.
  let intlRequest: NextRequest = request;
  const country = request.headers.get('x-vercel-ip-country');
  const hasLocaleCookie = request.cookies.has('NEXT_LOCALE');

  if (country && COUNTRY_LOCALE_MAP[country] && !hasLocaleCookie) {
    const geoLocale = COUNTRY_LOCALE_MAP[country];
    const headers = new Headers(request.headers);
    headers.set('Accept-Language', `${geoLocale},en;q=0.5`);
    intlRequest = new NextRequest(request.url, {
      headers,
      method: request.method,
    });
    // Copy cookies from original request
    request.cookies.getAll().forEach((cookie) => {
      intlRequest.cookies.set(cookie.name, cookie.value);
    });
  }

  // --- Run intl middleware first for page routes ---
  const intlResponse = intlMiddleware(intlRequest);

  // Refresh Supabase auth session on every request
  const response = await updateSession(request);

  // ── Supabase-wins locale hydration ──────────────────────────────────────────
  // If the authenticated user has a stored locale preference, overwrite the
  // NEXT_LOCALE cookie when it differs. This reverses the prior I18N-LOCK-01
  // rule for one specific case: the user's own stored choice always wins over
  // a stale cookie or a stale ?locale= quiz-handoff value.
  //
  // Order of precedence (highest → lowest):
  //   1. Supabase user_prefs.locale (this block)
  //   2. NEXT_LOCALE cookie (already on the request)
  //   3. ?locale= query param from the funnel (handled below  -  still guarded)
  //   4. Geo / Accept-Language / 'en' default (handled by intl middleware)
  //
  // Note: intlMiddleware already ran above against the request's cookies, so a
  // cookie change here takes visible effect on the NEXT navigation. The
  // switcher path is immediate because next-intl router.replace handles the
  // locale-prefix redirect client-side.
  {
    const { createServerClient } = await import('@supabase/ssr');
    const hydrationClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { flowType: 'implicit' },
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            /* read-only here */
          },
        },
      }
    );
    const {
      data: { user },
    } = await hydrationClient.auth.getUser();
    if (user) {
      const { data: prefs } = await hydrationClient
        .from('user_prefs')
        .select('locale')
        .eq('user_id', user.id)
        .maybeSingle();
      const stored = prefs?.locale;
      if (stored && (routing.locales as readonly string[]).includes(stored)) {
        const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
        if (cookieLocale !== stored) {
          response.cookies.set('NEXT_LOCALE', stored, {
            path: '/',
            maxAge: 365 * 24 * 60 * 60,
            sameSite: 'lax',
          });
        }
      }
    }
  }

  // Merge intl response headers (locale cookie, etc.) into auth response
  intlResponse.headers.forEach((value, key) => {
    response.headers.set(key, value);
  });
  // Copy intl cookies (e.g. NEXT_LOCALE) into response
  intlResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie.name, cookie.value);
  });

  // If intl middleware issued a redirect (locale prefix add/remove), follow it
  if (intlResponse.status >= 300 && intlResponse.status < 400) {
    const redirectUrl = intlResponse.headers.get('location');
    if (redirectUrl) {
      const redirectResponse = NextResponse.redirect(new URL(redirectUrl, request.url));
      // Carry over auth cookies from session refresh
      response.cookies.getAll().forEach((cookie) => {
        redirectResponse.cookies.set(cookie.name, cookie.value);
      });
      return redirectResponse;
    }
  }

  // Normalize pathname for route matching (strip locale prefix)
  const normalizedPathname = stripLocalePrefix(pathname);
  const locale = resolveLocale(pathname);

  // --- Token relay: exchange one-time auth_token for PWA session ---
  const authToken = request.nextUrl.searchParams.get('auth_token');
  const localeParam = request.nextUrl.searchParams.get('locale');
  if (authToken) {
    const { createServerClient } = await import('@supabase/ssr');
    const exchangeClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { flowType: 'implicit' },
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await exchangeClient.auth.verifyOtp({
      token_hash: authToken,
      type: 'email',
    });

    if (!error) {
      // Strip auth_token and locale from URL and redirect to clean path
      const cleanUrl = request.nextUrl.clone();
      cleanUrl.searchParams.delete('auth_token');
      cleanUrl.searchParams.delete('locale');

      // If locale param was passed from funnel, redirect to locale-prefixed path
      if (localeParam && (routing.locales as readonly string[]).includes(localeParam) && localeParam !== routing.defaultLocale) {
        const cleanPath = stripLocalePrefix(cleanUrl.pathname);
        cleanUrl.pathname = localePath(cleanPath, localeParam);
      }

      const redirectResponse = NextResponse.redirect(cleanUrl);

      // Quiz-handoff guard: do not overwrite an existing NEXT_LOCALE cookie with
      // a stale ?locale= query param. The user's own choice (Supabase user_prefs
      // hydrated above) is the only authority that may overwrite the cookie.
      if (localeParam && (routing.locales as readonly string[]).includes(localeParam)) {
        const existingLocaleCookie = request.cookies.get('NEXT_LOCALE');
        if (!existingLocaleCookie) {
          redirectResponse.cookies.set('NEXT_LOCALE', localeParam, {
            path: '/',
            maxAge: 365 * 24 * 60 * 60,
            sameSite: 'lax',
          });
        }
      }

      // Copy session cookies from exchange onto redirect response
      response.cookies.getAll().forEach((cookie) => {
        redirectResponse.cookies.set(cookie.name, cookie.value);
      });
      return redirectResponse;
    }
    // If token exchange fails (expired/already used), fall through to normal auth gate
    console.error('[pwa/proxy] auth_token exchange failed:', {
      message: error.message,
      status: error.status,
      code: (error as { code?: string }).code,
    });
  }

  // --- Locale relay: set NEXT_LOCALE from query param (fallback redirect without auth_token) ---
  if (localeParam && !authToken && (routing.locales as readonly string[]).includes(localeParam)) {
    // Quiz-handoff guard: do not overwrite an existing NEXT_LOCALE cookie with
    // a stale ?locale= query param. The user's own choice (Supabase user_prefs
    // hydrated above) is the only authority that may overwrite the cookie.
    const existingLocaleCookie = request.cookies.get('NEXT_LOCALE');
    if (!existingLocaleCookie) {
      response.cookies.set('NEXT_LOCALE', localeParam, {
        path: '/',
        maxAge: 365 * 24 * 60 * 60,
        sameSite: 'lax',
      });
    }
    // Strip locale param and redirect to locale-prefixed clean URL
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete('locale');
    if (localeParam !== routing.defaultLocale) {
      const cleanPath = stripLocalePrefix(cleanUrl.pathname);
      cleanUrl.pathname = localePath(cleanPath, localeParam);
    }
    const localeRedirect = NextResponse.redirect(cleanUrl);
    response.cookies.getAll().forEach((cookie) => {
      localeRedirect.cookies.set(cookie.name, cookie.value);
    });
    return localeRedirect;
  }

  // ── Auth gate ──────────────────────────────────────────────────────────────
  // Public paths (no login required). Everything else requires a Supabase user.
  const PUBLIC_PATHS = ["/login", "/auth", "/~offline"];
  const isPublic = PUBLIC_PATHS.some((p) => normalizedPathname === p || normalizedPathname.startsWith(`${p}/`));
  if (!isPublic) {
    const { createServerClient } = await import("@supabase/ssr");
    const authClient = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { flowType: 'implicit' },
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            /* read-only */
          },
        },
      },
    );
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = localePath("/login", locale);
      loginUrl.searchParams.delete("auth_token");
      const redirect = NextResponse.redirect(loginUrl);
      response.cookies.getAll().forEach((c) => redirect.cookies.set(c.name, c.value));
      return redirect;
    }
  }

  return response;
}

export const config = {
  matcher: [
    // /.well-known is excluded so the Apple Pay domain-verification file is
    // served as-is: it is extensionless, and without this the request falls
    // through to the auth gate below and 307s to /login — which violates
    // Solidgate's "no authentication required" rule for that path.
    '/((?!_next/static|_next/image|favicon.ico|icon-.*\\.png|images/.*|sw\\.js|workbox-.*\\.js|manifest\\.webmanifest|\\.well-known/|~offline).*)',
  ],
};
