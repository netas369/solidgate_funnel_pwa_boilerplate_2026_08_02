import { NextResponse, NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from '@repo/shared/supabase/middleware';
import { verifyPaymentCookie, PAYMENT_COOKIE_NAME } from '@repo/shared/payment-cookie';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { Database } from '@repo/shared/types/database';
import {
  currentPaymentEnvironment,
  type PaymentEnvironment,
} from '@repo/shared/payment-environment';
import {
  SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME,
  verifySolidgateMainAcceptedCookie,
  type SolidgateMainAcceptedCookieBinding,
} from '@repo/shared/solidgate/main-accepted-cookie';
import { SOLIDGATE_PRODUCT_CODES } from '@repo/shared/solidgate/catalog';
import { FUNNEL_CODE } from '@/features/analytics/lib/checkout-context';
import { PAID_MAIN_CHECKOUT_TIER_SLUGS } from '@/lib/payment/checkout-tiers';
import {
  buildSolidgateOrderId,
  parseSolidgateOrderId,
} from '@repo/shared/solidgate/order-id';
import createIntlMiddleware from 'next-intl/middleware';
import { routing, LOCALE_URL_PREFIX } from '@repo/i18n/routing';

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
  MD: 'ru',
  UA: 'ru',
  // Chinese Traditional
  TW: 'zh-TW',
  HK: 'zh-TW',
  MO: 'zh-TW',
};

const MAIN_ACCEPTED_ORDER_COLUMNS = [
  'id',
  'payment_environment',
  'solidgate_order_id',
  'session_id',
  'psp',
  'product_name',
  'product_slug',
  'amount_cents',
  'currency',
  'status',
  'tracking_metadata',
  'solidgate_subscription_id',
  'solidgate_payment_status',
  'solidgate_original_amount_cents',
  'solidgate_refunded_amount_cents',
  'solidgate_chargeback_id',
  'solidgate_chargeback_status',
  'solidgate_chargeback_amount_cents',
  'solidgate_customer_email',
  'solidgate_checkout_locale',
  'solidgate_product_id',
  'solidgate_payment_action',
  'solidgate_checkout_identity_legacy',
].join(',');

const CAPTURED_MAIN_ORDER_STATUSES = new Set(['completed', 'trialing', 'active']);
const CAPTURED_MAIN_PAYMENT_STATUSES = new Set(['settle_ok', 'partial_settled']);

type MainAcceptedOrder = Pick<
  Database['public']['Tables']['orders']['Row'],
  | 'id'
  | 'payment_environment'
  | 'solidgate_order_id'
  | 'session_id'
  | 'psp'
  | 'product_name'
  | 'product_slug'
  | 'amount_cents'
  | 'currency'
  | 'status'
  | 'tracking_metadata'
  | 'solidgate_subscription_id'
  | 'solidgate_payment_status'
  | 'solidgate_original_amount_cents'
  | 'solidgate_refunded_amount_cents'
  | 'solidgate_chargeback_id'
  | 'solidgate_chargeback_status'
  | 'solidgate_chargeback_amount_cents'
  | 'solidgate_customer_email'
  | 'solidgate_checkout_locale'
  | 'solidgate_product_id'
  | 'solidgate_payment_action'
  | 'solidgate_checkout_identity_legacy'
>;

function isCanonicalAcceptedMainOrder(
  row: MainAcceptedOrder,
  binding: SolidgateMainAcceptedCookieBinding,
  paymentEnvironment: PaymentEnvironment,
): boolean {
  const parsed = parseSolidgateOrderId(binding.orderId);
  if (
    !parsed ||
    parsed.sessionId !== binding.sessionId ||
    parsed.attempt > 999_999_999 ||
    !PAID_MAIN_CHECKOUT_TIER_SLUGS.has(parsed.offeringSlug)
  ) {
    return false;
  }

  try {
    if (
      buildSolidgateOrderId(parsed.sessionId, parsed.offeringSlug, parsed.attempt) !==
      binding.orderId
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const metadata = row.tracking_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const boundMetadata = metadata as Record<string, unknown>;
  const expectedVariant = parsed.offeringSlug === 'special_1eur' ? 'special_1eur' : 'main';
  const grossAmount = row.solidgate_original_amount_cents ?? row.amount_cents;
  const pendingAuthorization =
    row.status === 'pending' && row.solidgate_payment_status === 'auth_ok';
  const capturedAuthorization =
    CAPTURED_MAIN_ORDER_STATUSES.has(row.status) &&
    row.solidgate_payment_status !== null &&
    CAPTURED_MAIN_PAYMENT_STATUSES.has(row.solidgate_payment_status);

  return (
    binding.paymentEnvironment === paymentEnvironment &&
    row.payment_environment === paymentEnvironment &&
    row.solidgate_order_id === binding.orderId &&
    row.session_id === binding.sessionId &&
    row.psp === 'solidgate' &&
    row.product_name === SOLIDGATE_PRODUCT_CODES.main &&
    row.product_slug === SOLIDGATE_PRODUCT_CODES.main &&
    row.solidgate_checkout_identity_legacy === false &&
    row.solidgate_payment_action === 'auth_settle' &&
    Number.isSafeInteger(grossAmount) &&
    grossAmount > 0 &&
    row.amount_cents === grossAmount &&
    /^[a-z]{3}$/.test(row.currency) &&
    typeof row.solidgate_subscription_id === 'string' &&
    row.solidgate_subscription_id.length > 0 &&
    typeof row.solidgate_customer_email === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.solidgate_customer_email) &&
    typeof row.solidgate_checkout_locale === 'string' &&
    row.solidgate_checkout_locale.length > 0 &&
    typeof row.solidgate_product_id === 'string' &&
    row.solidgate_product_id.length > 0 &&
    row.solidgate_refunded_amount_cents === 0 &&
    row.solidgate_chargeback_id === null &&
    row.solidgate_chargeback_status === null &&
    row.solidgate_chargeback_amount_cents === 0 &&
    boundMetadata.funnel_code === FUNNEL_CODE &&
    boundMetadata.funnel_variant === expectedVariant &&
    boundMetadata.session_id === binding.sessionId &&
    boundMetadata.product_slug === parsed.offeringSlug &&
    typeof boundMetadata.price_id === 'string' &&
    boundMetadata.price_id.trim().length > 0 &&
    (pendingAuthorization || capturedAuthorization)
  );
}

/**
 * Strip locale prefix from pathname for route matching.
 * With `localePrefix: 'as-needed'`, English paths have no prefix (/quiz),
 * but non-default locale paths do (/lt/quiz). We normalize so the existing
 * funnel route checks work regardless of locale.
 */
function stripLocalePrefix(pathname: string): string {
  for (const locale of routing.locales) {
    if (locale === routing.defaultLocale) continue;
    const prefix = LOCALE_URL_PREFIX[locale];
    if (pathname === `/${prefix}` || pathname.startsWith(`/${prefix}/`)) {
      return pathname.replace(`/${prefix}`, '') || '/';
    }
  }
  return pathname;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Documentation owns a layout outside [locale] and is public for now.
  // Keep this independent of locale redirects and Supabase session refresh.
  if (pathname === '/documentation' || pathname.startsWith('/documentation/')) {
    return NextResponse.next();
  }

  // API routes bypass i18n middleware entirely.
  if (pathname.startsWith('/api/')) {
    return await updateSession(request);
  }

  // ── /admin: bypass intl middleware + enforce email allowlist (D-05/D-06/D-07/D-08) ──
  // /admin lives outside [locale]. Pre-send allowlist filter lives in the route
  // handler at /api/admin/auth/request-otp. Per-request gating lives here.
  if (pathname.startsWith('/admin')) {
    // /admin/login is the only publicly reachable /admin/* path (D-07).
    if (pathname === '/admin/login' || pathname.startsWith('/admin/login/')) {
      return await updateSession(request);
    }

    // All other /admin/* require an authenticated, allowlisted user.
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const supabaseAdminGate = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            // read-only here; updateSession() handles cookie refresh below
          },
        },
      },
    );
    const {
      data: { user: adminUser },
    } = await supabaseAdminGate.auth.getUser();
    const isAllowed =
      !!adminUser?.email && adminEmails.includes(adminUser.email.toLowerCase());

    if (!isAllowed) {
      // D-07: silent redirect to funnel root. No 403, no /admin/dashboard leak.
      return NextResponse.redirect(new URL('/', request.url));
    }

    return await updateSession(request);
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

  // Run next-intl middleware for locale detection / rewriting.
  const intlResponse = intlMiddleware(intlRequest);

  // If intl middleware issued a redirect (e.g. / → /lt/ for geo-detected locale),
  // return it immediately  -  session update is unnecessary for redirects.
  if (intlResponse.redirected || (intlResponse.status >= 300 && intlResponse.status < 400)) {
    return intlResponse;
  }

  // Normalize pathname (strip locale prefix) for funnel route matching.
  const normalizedPathname = stripLocalePrefix(pathname);

  const isFunnelRoute =
    normalizedPathname === '/quiz' ||
    normalizedPathname === '/offer' ||
    normalizedPathname === '/success' ||
    normalizedPathname.startsWith('/oto/');

  // Lock paid authenticated users out of post-quiz funnel routes.
  // /quiz is always accessible  -  the quiz page resets the session on mount,
  // so returning users can retake the quiz without being bounced to the PWA.
  if (isFunnelRoute && normalizedPathname !== '/quiz') {
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {
            // no-op  -  middleware only needs to read cookies for this lookup
          },
        },
      },
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    let authenticatedHasCompletedOrder = false;
    if (user) {
      const { data: hasOrder } = await supabase
        .from('orders')
        .select('id')
        .eq('payment_environment', currentPaymentEnvironment())
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .limit(1)
        .maybeSingle();

      const isSuccessPage = normalizedPathname === '/success';
      const isOtoPage = normalizedPathname.startsWith('/oto/');

      if (hasOrder) {
        authenticatedHasCompletedOrder = true;
        // Phase 1004: Allow authenticated users with completed orders to access OTO pages
        // even without payment cookie (cross-device scenario per D-13).
        const hasAuthenticatedOtoAccess = isOtoPage;

        if (!isSuccessPage && !hasAuthenticatedOtoAccess) {
          return NextResponse.redirect(new URL('/dashboard', request.url));
        }
        // hasAuthenticatedOtoAccess / isSuccessPage: fall through
      }
    }

    // Authentication by itself is not proof of a successful main checkout.
    // Users without a completed purchase must pass the same exact cookie + DB
    // binding check as anonymous visitors, otherwise a declined card could
    // reach the OTO marketing pages simply by logging in first.
    if (normalizedPathname.startsWith('/oto/') && !authenticatedHasCompletedOrder) {
      const cookie = request.cookies.get(PAYMENT_COOKIE_NAME);
      const verified = cookie ? await verifyPaymentCookie(cookie.value) : null;

      const acceptedCookie = request.cookies.get(SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME);
      const acceptedBinding = acceptedCookie
        ? await verifySolidgateMainAcceptedCookie(acceptedCookie.value)
        : null;
      const paymentEnvironment = currentPaymentEnvironment();

      if (!verified && acceptedBinding?.paymentEnvironment !== paymentEnvironment) {
        return NextResponse.redirect(new URL('/offer', request.url));
      }
      if (
        !verified &&
        normalizedPathname !== '/oto/1' &&
        acceptedBinding?.paymentEnvironment === paymentEnvironment
      ) {
        return NextResponse.redirect(new URL('/oto/1', request.url));
      }

      // The cookie's id is the Solidgate order id ({sessionId}:{tier}:{attempt}),
      // minted by /api/solidgate/grant after the server verified the payment.
      // (legacy 'sub'-kind and pi_… cookies can no longer be minted; a
      // stale one simply matches no order and falls back to /offer.)
      //
      // DB verification uses the admin client because migration 00018 dropped
      // anon SELECT on orders (audit C5).
      const admin = getSupabaseAdminClient();
      let orderFound = false;

      if (verified?.kind === 'pi' && verified.paymentIntentId) {
        const { data: order } = await admin
          .from('orders')
          .select('id')
          .eq('payment_environment', paymentEnvironment)
          .eq('solidgate_order_id', verified.paymentIntentId)
          .eq('session_id', verified.sessionId)
          .maybeSingle();
        orderFound = Boolean(order);
      }

      // A paid auth_ok is safe to use only as a short-lived admission ticket
      // for the first OTO's marketing page. It is not payment access: local DB
      // truth must still be the exact canonical main reservation (or the same
      // order captured by a racing webhook), and later OTOs remain locked.
      if (
        !orderFound &&
        normalizedPathname === '/oto/1' &&
        acceptedBinding?.paymentEnvironment === paymentEnvironment
      ) {
        const { data: rawAcceptedOrder, error: acceptedOrderError } = await admin
          .from('orders')
          .select(MAIN_ACCEPTED_ORDER_COLUMNS)
          .eq('payment_environment', paymentEnvironment)
          .eq('solidgate_order_id', acceptedBinding.orderId)
          .eq('session_id', acceptedBinding.sessionId)
          .maybeSingle();
        const acceptedOrder = rawAcceptedOrder as MainAcceptedOrder | null;
        orderFound =
          !acceptedOrderError &&
          acceptedOrder !== null &&
          isCanonicalAcceptedMainOrder(
            acceptedOrder,
            acceptedBinding,
            paymentEnvironment,
          );
      }

      if (!orderFound) {
        if (
          normalizedPathname !== '/oto/1' &&
          acceptedBinding?.paymentEnvironment === paymentEnvironment
        ) {
          return NextResponse.redirect(new URL('/oto/1', request.url));
        }
        return NextResponse.redirect(new URL('/offer', request.url));
      }
    }
  }

  // Run Supabase session update and merge intl headers into the response.
  const sessionResponse = await updateSession(request);

  // Merge intl middleware headers (locale cookie, content-language, etc.)
  // into the session response.
  intlResponse.headers.forEach((value, key) => {
    sessionResponse.headers.set(key, value);
  });

  return sessionResponse;
}

export const config = {
  matcher: [
    // Skip Next internals, favicon,
    // /.well-known (Apple Pay domain verification — the file is extensionless,
    // so the extension list below cannot cover it and the intl rewrite would
    // 404 it; Solidgate requires HTTPS + text/plain + no auth on that path),
    // the root metadata routes (robots/sitemap/manifest — the intl rewrite would
    // 404 them, breaking crawling and the PWA manifest), and known static file
    // extensions so /public files load without intl rewrites.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp4|webm|mov|m4v|ogg|js|wasm|map)$).*)',
  ],
};
