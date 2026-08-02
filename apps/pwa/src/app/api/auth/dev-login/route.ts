import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { createClient } from '@repo/shared/supabase/server';

/**
 * DEV-ONLY passwordless login.
 *
 * While building out the member area locally, sign in with ANY email and no OTP
 * code. Mints a real Supabase session (createUser -> generateLink -> verifyOtp),
 * so every getUser()-gated page and API route behaves exactly as it would after
 * a real OTP login -- no proxy/auth-gate bypass needed.
 *
 * Double-gated so it can never run outside local development:
 *   1. NODE_ENV must not be 'production' (every Vercel build — prod AND preview —
 *      sets NODE_ENV=production, so this route is 404 on all deployments), and
 *   2. NEXT_PUBLIC_ENABLE_DEV_LOGIN must be explicitly 'true' (opt-in per machine).
 * The matching UI branch reads the same flag, so the real 6-digit OTP flow is the
 * default everywhere and this shortcut is off unless a developer turns it on.
 */

const DEV_LOGIN_ENABLED =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === 'true';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isExistingUserError(
  error: { message?: string | null; status?: number | null; code?: string | null } | null,
) {
  if (!error) return false;
  // Prefer error.code: GoTrue's wording drifted to "already BEEN registered",
  // which the message-only regex missed — so signing in as an existing user
  // failed with "Could not create dev user".
  const code = error.code ?? null;
  if (code === 'email_exists' || code === 'user_already_exists') return true;
  // Don't gate on status: GoTrue has answered 400 and 422 for this at different
  // times, and "the user exists" is what the message says either way.
  const message = error.message?.toLowerCase() ?? '';
  return /already\s+(?:been\s+)?registered|already\s+exists|duplicate/.test(message);
}

export async function POST(request: Request) {
  if (!DEV_LOGIN_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = (await request.json()) as { email?: unknown };
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }

    const admin = getSupabaseAdminClient();

    // Ensure an auth user exists for this email (idempotent -- ignore duplicates).
    const { error: createUserError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createUserError && !isExistingUserError(createUserError)) {
      console.error('[auth/dev-login] createUser failed:', createUserError.message);
      return NextResponse.json({ error: 'Could not create dev user' }, { status: 500 });
    }

    // Mint a one-time token and exchange it for a real session cookie.
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    if (linkError || !linkData?.properties?.hashed_token) {
      console.error(
        '[auth/dev-login] generateLink failed:',
        linkError?.message ?? 'missing hash',
      );
      return NextResponse.json({ error: 'Could not generate session' }, { status: 500 });
    }

    const supabase = await createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'email',
    });
    if (verifyError) {
      console.error('[auth/dev-login] verifyOtp failed:', verifyError.message);
      return NextResponse.json({ error: 'Could not establish session' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, redirectTo: '/dashboard' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('[auth/dev-login] unexpected:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
