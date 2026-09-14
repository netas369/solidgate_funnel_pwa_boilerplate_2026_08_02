import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@repo/shared/supabase/server';
import { isCroAnalyst } from '@/lib/cro-auth';

export const dynamic = 'force-dynamic';

/**
 * Opens the board already signed in, for someone arriving from PMC Hub.
 *
 * Mirrors the funnel→PWA handoff in apps/pwa/src/proxy.ts: a one-time
 * hashed_token minted server-side by something that holds the service-role key,
 * redeemed here with the ANON key. verifyOtp needs no elevated credential, so
 * this app still holds nothing capable of reading a quiz answer.
 *
 * The token is minted by apps/funnel's /api/internal/cro-login-link, which
 * refuses any address not already in cro_analysts. This route re-checks
 * membership anyway — the two are different moments, and someone can be removed
 * between the mint and the click.
 *
 * EVERY FAILURE LANDS ON /login, never on an error page. A stale link, a
 * reused one, a revoked analyst: in all of them the honest next step is the
 * same, which is to sign in normally. An error screen would strand someone who
 * is one click from getting in.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const login = new URL('/login', request.url);

  if (!token) {
    login.searchParams.set('sso', 'missing');
    return NextResponse.redirect(login);
  }

  // Bound before it reaches Supabase. The hash is fixed-length; anything else
  // is a probe, and there is no reason to pay a round trip for it.
  if (token.length > 512) {
    login.searchParams.set('sso', 'invalid');
    return NextResponse.redirect(login);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: token, type: 'email' });
  if (error) {
    // Single-use and short-lived, so this is ordinary: a link opened twice, or
    // opened tomorrow. Not worth a console.error on every occurrence.
    login.searchParams.set('sso', 'expired');
    return NextResponse.redirect(login);
  }

  // Membership on THIS client instance, not a fresh one. verifyOtp wrote the
  // session through cookieStore.set, and a second createClient() in the same
  // request reads cookies() — which does not yet reflect that write, so the
  // check would run unauthenticated and fail closed for everyone. The same
  // trap is documented at length in lib/cro-otp.ts.
  if (!(await isCroAnalyst(supabase))) {
    // A valid token for a real user who is not an analyst — an address removed
    // from the list after the link was minted. Tear the session down rather
    // than leave them holding one on this domain.
    await supabase.auth.signOut();
    login.searchParams.set('sso', 'denied');
    return NextResponse.redirect(login);
  }

  // The token never survives into history or a Referer: this is a redirect, and
  // the destination carries none of it.
  return NextResponse.redirect(new URL('/dashboard', request.url));
}
