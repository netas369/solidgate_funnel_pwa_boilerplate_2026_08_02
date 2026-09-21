import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { PAYMENT_COOKIE_NAME, verifyPaymentCookie } from '../payment-cookie';
import { claimVerifiedPurchaseSession } from './claim-verified-session';
import { getSupabaseAdminClient } from '../supabase/admin';
import { createClient } from '../supabase/server';
import { currentPaymentEnvironment } from '../payment-environment';
import { backfillOrderEntitlement } from './entitlement-backfill';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TOKEN_PATTERN = /^\d{6}$/;

function normalizeEmail(email: unknown) {
  if (typeof email !== 'string') {
    return null;
  }

  const normalizedEmail = email.trim().toLowerCase();

  return EMAIL_PATTERN.test(normalizedEmail) ? normalizedEmail : null;
}

function normalizeToken(token: unknown) {
  if (typeof token !== 'string') {
    return null;
  }

  const normalizedToken = token.trim();

  return OTP_TOKEN_PATTERN.test(normalizedToken) ? normalizedToken : null;
}

export interface VerifyOtpOptions {
  /**
   * App-specific rate limiting. Return { allowed: false, ... } to reject.
   * If not provided, rate limiting is skipped (app must handle it separately).
   */
  checkRateLimit?: (email: string) => Promise<{
    allowed: boolean;
    reason?: string;
    retryAfterMinutes?: number;
  }>;

  /**
   * Record OTP attempt for rate limiting tracking.
   * If not provided, attempt recording is skipped.
   */
  recordAttempt?: (email: string, success: boolean, ipAddress: string | null) => void;

  /**
   * Resolve the redirect URL after successful verification.
   * Receives the authenticated userId for app-specific routing.
   * Default: returns '/dashboard'
   */
  getRedirectUrl: (userId: string) => Promise<string>;
}

export async function handleVerifyOtp(
  request: Request,
  options: VerifyOtpOptions,
): Promise<Response> {
  try {
    const paymentEnvironment = currentPaymentEnvironment();
    const body = (await request.json()) as { email?: unknown; token?: unknown };
    const email = normalizeEmail(body.email);
    const token = normalizeToken(body.token);

    if (!email) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }

    if (!token) {
      return NextResponse.json({ error: 'A valid 6-digit code is required' }, { status: 400 });
    }

    // Rate-limit check (app-provided)
    if (options.checkRateLimit) {
      const rateLimit = await options.checkRateLimit(email);
      if (!rateLimit.allowed) {
        const message =
          rateLimit.reason === 'hard_lock'
            ? `Too many failed attempts. Please contact support or try again in ${rateLimit.retryAfterMinutes} minutes.`
            : `Too many failed attempts. Please wait ${rateLimit.retryAfterMinutes} minutes before trying again.`;
        return NextResponse.json({ error: message }, { status: 429 });
      }
    }

    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null;

    const supabase = await createClient();
    const { data: authData, error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (verifyError || !authData.user) {
      console.error('[auth/verify-otp] verifyOtp failed:', {
        errorMessage: verifyError?.message,
        errorStatus: verifyError?.status,
        email,
        hasUser: !!authData.user,
      });
      // Record failure before returning -- fire-and-forget
      options.recordAttempt?.(email, false, ipAddress);
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });
    }

    // Record success
    options.recordAttempt?.(email, true, ipAddress);

    const admin = getSupabaseAdminClient();

    // D-06: Targeted session linking -- link unlinked sessions for this user's email
    const { data: unlinkedSessions } = await admin
      .from('sessions')
      .select('id')
      .eq('email', email)
      .is('user_id', null);

    if (unlinkedSessions && unlinkedSessions.length > 0) {
      const unlinkedIds = unlinkedSessions.map((s: { id: string }) => s.id);

      // Link sessions to authenticated user
      await admin
        .from('sessions')
        .update({ user_id: authData.user.id })
        .in('id', unlinkedIds);

      // Seed user_prefs.locale from the most recent unlinked session's locale
      // so the PWA opens in the user's funnel language even from generic links.
      // Only writes when no user_prefs row exists  -  never overrides an explicit
      // user choice made via the PWA language switcher.
      const { data: existingPrefs } = await admin
        .from('user_prefs')
        .select('user_id')
        .eq('user_id', authData.user.id)
        .maybeSingle();
      if (!existingPrefs) {
        const { data: latestSessionLocale } = await admin
          .from('sessions')
          .select('locale')
          .in('id', unlinkedIds)
          .not('locale', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (latestSessionLocale?.locale) {
          const { error: prefsError } = await admin.from('user_prefs').insert({
            user_id: authData.user.id,
            locale: latestSessionLocale.locale,
            updated_at: new Date().toISOString(),
          });
          if (prefsError) {
            console.error('[auth/verify-otp] user_prefs insert failed:', prefsError.message);
          }
        }
      }

      // Assign purchase ownership; generic email login does not claim a saved card.
      await admin
        .from('orders')
        .update({ user_id: authData.user.id })
        .eq('payment_environment', paymentEnvironment)
        .in('session_id', unlinkedIds)
        .is('user_id', null);

      // Phase 1007: Create entitlements for all orders in newly-linked sessions (D-09)
      const { data: linkedOrders } = await admin
        .from('orders')
        .select(
          'id, psp, product_name, product_slug, status, created_at, amount_cents, solidgate_original_amount_cents, solidgate_subscription_id',
        )
        .eq('payment_environment', paymentEnvironment)
        .in('session_id', unlinkedIds)
        .eq('user_id', authData.user.id)
        .in('status', ['completed', 'trialing']);

      if (linkedOrders) {
        for (const order of linkedOrders) {
          await backfillOrderEntitlement({
            admin,
            order,
            userId: authData.user.id,
            paymentEnvironment,
            source: 'otp_verify',
          });
        }
      }

    }

    // The current signed journey plus a successful mailbox challenge authorizes
    // its saved card. Do not promote every session that happens to use this
    // email: another anonymous checkout could have supplied the same address.
    const signedCookie = (await cookies()).get(PAYMENT_COOKIE_NAME)?.value;
    const payment = signedCookie ? await verifyPaymentCookie(signedCookie) : null;
    if (payment && authData.user.email?.trim().toLowerCase() === email) {
      await claimVerifiedPurchaseSession({
        admin, userId: authData.user.id, email,
        sessionId: payment.sessionId, paymentEnvironment, source: 'otp_verify',
      });
    }

    const redirectTo = await options.getRedirectUrl(authData.user.id);

    return NextResponse.json({ ok: true, redirectTo }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
