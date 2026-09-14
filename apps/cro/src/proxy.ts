import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { updateSession } from '@repo/shared/supabase/middleware';
import type { Database } from '@repo/shared/types/database';
import { isCroAnalyst } from '@/lib/cro-auth';

/**
 * Per-request gate for the whole CRO app.
 *
 * Mirrors the /admin block in apps/funnel/src/proxy.ts, minus the intl and
 * payment machinery this app has no use for. Everything except /login and the
 * auth endpoints requires an authenticated, allowlisted user.
 *
 * Defence in depth, not the only defence: even a caller who defeats this
 * reaches an app holding nothing but the anon key, and every cro_* function
 * re-checks the caller's email against the cro_analysts table inside Postgres.
 * This layer exists so an unauthorized visitor sees a redirect instead of a
 * dashboard shell that then fails every query.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Auth endpoints must stay reachable or nobody can ever log in. Opening them
  // is not a way in: verify-otp resolves membership against cro_analysts before
  // it hands back a redirect, and signs out anyone who is not on the list.
  if (pathname.startsWith('/api/auth/')) {
    return await updateSession(request);
  }

  // The only publicly reachable page.
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    return await updateSession(request);
  }

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // read-only here; updateSession() refreshes cookies below
        },
      },
    },
  );

  // Cheap pre-check before the RPC. is_cro_analyst() is granted to
  // `authenticated` only, so calling it with no session is a guaranteed 42501 —
  // and this proxy runs on EVERY matched path, so every bot scan of
  // the cro. hostname and every dev-server request to :3207 would write one
  // "permission denied for function is_cro_analyst" into the Postgres log. The
  // outcome is unchanged (no session, no access); we just stop paying a failed
  // round trip to say so.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // One source of truth: public.cro_analysts, checked per request. Revoking
  // someone therefore takes effect on their next page load rather than whenever
  // their session happens to expire — or, as with the env allowlist this
  // replaced, whenever somebody next deploys.
  if (!user || !(await isCroAnalyst(supabase))) {
    // Redirect to /login rather than 403. A 403 confirms the path exists and
    // that the visitor simply lacks access; a redirect tells them nothing.
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|map)$).*)',
  ],
};
