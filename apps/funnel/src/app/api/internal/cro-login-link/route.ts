import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * Mints a one-time link that opens this product's CRO board already signed in.
 *
 * WHY THIS LIVES IN THE FUNNEL AND NOT IN apps/cro.
 *
 * Establishing a Supabase session for an arbitrary address requires the
 * service-role key. apps/cro deliberately holds only the anon key — that is the
 * property the whole CRO design rests on, and a test fails the build if the
 * string appears in that app. So the board cannot mint its own entry; something
 * that already holds elevated credentials has to, and the funnel already does.
 *
 * WHAT THE CALLER CAN AND CANNOT DO.
 *
 * PMC Hub holds INTERNAL_API_SECRET for this product. That secret lets it open
 * the board as SOMEONE ALREADY ON THE ANALYST LIST — nothing more. It cannot
 * grant access: an address that is not in cro_analysts is refused here, before
 * any link exists. Granting is still an INSERT performed by a person.
 *
 * That is the difference between this and handing PMC Hub a service-role key,
 * which would make one internal app a full-database credential for every
 * product built from this template.
 *
 * FIRST-TIME ANALYSTS DEPEND ON SIGNUPS BEING ENABLED. Granting access is an
 * INSERT into cro_analysts, which creates no auth user, so the first link for a
 * new analyst is minted for an address GoTrue has never seen. generateLink
 * creates the user on the way past — but only while Authentication → Providers
 * → Email → "Allow new users to sign up" is on. Turning it off as a hardening
 * step breaks every new analyst's first click and nothing else, which is a very
 * confusing failure. The same assumption is what makes cro-otp.ts pass
 * shouldCreateUser: true; see the note there.
 *
 * THE LINK IS MINTED PER CLICK, NOT PER PAGE RENDER. The token is Supabase's
 * own single-use OTP hash and expires with the project's OTP lifetime; a hub
 * page that embeds freshly minted links in every row would put a live
 * credential in the HTML for every analyst it lists, and leak them into
 * scrollback and browser history. Call this when the link is clicked and 302.
 */
function authorized(request: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    console.error('[cro-login-link] INTERNAL_API_SECRET is not set');
    return false;
  }
  const presented = request.headers.get('x-internal-secret');
  if (!presented) return false;

  // Constant-time, and length-guarded first: timingSafeEqual throws on a length
  // mismatch, which would both 500 and leak the secret's length by the
  // difference between a throw and a false.
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function croUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_CRO_URL;
  if (!base) {
    console.error('[cro-login-link] NEXT_PUBLIC_CRO_URL is not set');
    return null;
  }
  return base.replace(/\/+$/, '');
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const base = croUrl();
  if (!base) {
    return NextResponse.json({ error: 'CRO dashboard URL is not configured' }, { status: 500 });
  }

  let email: string;
  try {
    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email !== 'string' || !body.email.includes('@')) {
      return NextResponse.json({ error: 'email is required' }, { status: 400 });
    }
    // cro_analysts stores lowercase and CHECKs it, so anything else can never
    // match and would fail as "not an analyst" rather than as a typo.
    email = body.email.trim().toLowerCase();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();

  // THE GATE. Checked before a link exists, so a caller holding the secret can
  // never mint entry for an address a person has not already granted.
  const { data: analyst, error: analystError } = await admin
    .from('cro_analysts')
    .select('email')
    .eq('email', email)
    .maybeSingle();

  if (analystError) {
    console.error('[cro-login-link] analyst lookup failed:', analystError.message);
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 });
  }
  if (!analyst) {
    // 403 with no detail. The caller is trusted enough to ask and not trusted
    // enough to enumerate the team.
    return NextResponse.json({ error: 'Not an analyst' }, { status: 403 });
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !link?.properties.hashed_token) {
    console.error(
      '[cro-login-link] generateLink failed:',
      linkError?.message ?? 'missing hashed_token',
    );
    return NextResponse.json({ error: 'Could not mint a link' }, { status: 500 });
  }

  return NextResponse.json({
    url: `${base}/sso?token=${encodeURIComponent(link.properties.hashed_token)}`,
  });
}
