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
 * WHERE ACCESS IS ACTUALLY DECIDED — READ THIS BEFORE CHANGING THE GATE.
 *
 * Not here, and not in cro_analysts. That table holds ONE seeded row, the
 * shared PMC Hub identity (00001_baseline.sql), and PMC Hub mints as that
 * address for everyone. WHICH PEOPLE may open a board is a PMC Hub role,
 * decided in a different repo.
 *
 * The gate below is therefore not the thing keeping strangers out — PMC Hub's
 * own authentication is. What the gate still does is bound what this secret is
 * worth: a caller holding INTERNAL_API_SECRET can open the board as an address
 * already on the list, and cannot mint for an arbitrary one. That is still the
 * difference between this and handing PMC Hub a service-role key, which would
 * make one internal app a full-database credential for every product built from
 * this template.
 *
 * So: do not remove, relax or add a flag to the membership check below. The
 * shared-identity design works precisely BECAUSE none of the security code
 * changed — the address simply is on the list. If a change here looks
 * necessary, the requirement has been misread.
 *
 * TWO CONSEQUENCES OF THE SHARED IDENTITY, both accepted deliberately:
 *
 *   - The board cannot attribute a visit to a person. Every session arrives as
 *     the shared address. Fine while the boards are read-only aggregate counts;
 *     revisit it if one ever grows a write action.
 *   - Revocation is immediate at the door and delayed for anyone already
 *     inside. Removing someone in PMC Hub stops them minting a NEW session; a
 *     tab they already have open stays valid until Supabase expires it.
 *
 * SIGNUPS MUST STAY ENABLED. The shared address has no GoTrue user until the
 * first mint creates one, because seeding cro_analysts creates no auth user.
 * generateLink makes it on the way past — but only while Authentication →
 * Providers → Email → "Allow new users to sign up" is on. Turning it off as a
 * hardening step breaks the very first click on a freshly deployed product and
 * nothing else, which is a confusing failure to diagnose. The same assumption
 * is what makes cro-otp.ts pass shouldCreateUser: true; see the note there.
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

  // THE GATE. Unchanged by the move to PMC Hub roles, and deliberately so: it
  // is what stops a caller holding the secret from minting entry for an
  // arbitrary address. In practice the only address that passes is the shared
  // identity seeded in the baseline.
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
