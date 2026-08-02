import { NextResponse } from 'next/server';
import { BOILERPLATE_BRAND } from '../boilerplate-brand';
import { sendWelcomeEmail } from '../email/send-welcome-email';
import { getSupabaseAdminClient } from '../supabase/admin';
import { createClient } from '../supabase/server';
import { currentPaymentEnvironment } from '../payment-environment';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_SUCCESS_MESSAGE =
  `If that email is linked to a ${BOILERPLATE_BRAND.name} account, check your inbox for a 6-digit code.`;

// In-memory throttle for the paid-but-no-auth self-heal branch.
// Key: lowercased email. Value: epoch ms of last self-heal attempt.
// Per-instance scope is acceptable: the upper bound on duplication is a few
// extra (idempotent) createUser calls and a few extra welcome emails  -  both
// safe for a recovery flow.
const SELF_HEAL_THROTTLE = new Map<string, number>();
const SELF_HEAL_WINDOW_MS = 60_000;

function canSelfHeal(email: string): boolean {
  const last = SELF_HEAL_THROTTLE.get(email);
  const now = Date.now();
  if (last && now - last < SELF_HEAL_WINDOW_MS) return false;
  SELF_HEAL_THROTTLE.set(email, now);
  return true;
}

function normalizeEmail(email: unknown) {
  if (typeof email !== 'string') {
    return null;
  }

  const normalizedEmail = email.trim().toLowerCase();

  return EMAIL_PATTERN.test(normalizedEmail) ? normalizedEmail : null;
}

export async function handleRequestOtp(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { email?: unknown };
    const email = normalizeEmail(body.email);

    if (!email) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }

    const paymentEnvironment = currentPaymentEnvironment();

    const supabase = await createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
      },
    });

    if (otpError) {
      console.error('[auth/request-otp] signInWithOtp failed:', {
        errorMessage: otpError.message,
        errorStatus: otpError.status,
        email,
      });

      if (otpError.status === 429) {
        const seconds = otpError.message.match(/after (\d+) seconds/)?.[1];
        const retryMessage = seconds
          ? `Please wait ${seconds} seconds before requesting a new code.`
          : 'Too many requests. Please wait before trying again.';
        return NextResponse.json({ error: retryMessage }, { status: 429 });
      }

      // Self-heal branch: Supabase rejected OTP because no auth user exists
      // for this email AND shouldCreateUser is false. If the email belongs to
      // a paid buyer (completed order joined via sessions.email), create the
      // user, backfill user_id on sessions/orders, resend the welcome email,
      // and retry the OTP send. Throttled per-email to 1×/60s.
      const isMissingUserError =
        (otpError.status === 400 || otpError.status === 422) &&
        /signups? not allowed|user not found|otp_disabled/i.test(otpError.message);

      if (isMissingUserError && canSelfHeal(email)) {
        const admin = getSupabaseAdminClient();

        // Look up paid orders linked via sessions.email. orders has no email
        // column, so we go through sessions → orders (FK orders.session_id).
        const { data: sessRows } = await admin
          .from('sessions')
          .select('id, email, user_id, locale, orders!inner(status, user_id)')
          .eq('email', email)
          .eq('orders.status', 'completed')
          .eq('orders.payment_environment', paymentEnvironment)
          .limit(1);

        const hasPaidOrder = Array.isArray(sessRows) && sessRows.length > 0;

        if (hasPaidOrder) {
          // Create auth user (idempotent  -  race vs. webhook handled below).
          const { data: created, error: createErr } = await admin.auth.admin.createUser({
            email,
            email_confirm: true,
          });
          let userId: string | null = created?.user?.id ?? null;
          if (
            createErr &&
            !/already registered|already been registered/i.test(createErr.message)
          ) {
            console.error(
              '[auth/request-otp] self-heal createUser failed:',
              createErr.message,
            );
          }
          if (!userId) {
            // Lookup existing user (race or already-exists path).
            const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
            userId =
              list?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
          }

          if (userId) {
            // Backfill sessions.user_id + orders.user_id where null.
            await admin
              .from('sessions')
              .update({ user_id: userId })
              .eq('email', email)
              .is('user_id', null);
            const sessionIds = sessRows!.map((s: { id: string }) => s.id);
            if (sessionIds.length > 0) {
              await admin
                .from('orders')
                .update({ user_id: userId })
                .eq('payment_environment', paymentEnvironment)
                .in('session_id', sessionIds)
                .is('user_id', null);
            }

            // Resend welcome email (best-effort).
            const pwaUrl = process.env.NEXT_PUBLIC_PWA_URL;
            const sessLocale =
              (sessRows![0] as { locale?: string | null }).locale ?? null;
            if (pwaUrl && paymentEnvironment === 'production') {
              try {
                await sendWelcomeEmail({ email, pwaUrl, locale: sessLocale });
              } catch (e) {
                console.error(
                  '[auth/request-otp] self-heal welcome email failed:',
                  e instanceof Error ? e.message : e,
                );
              }
            }

            // Retry the OTP send  -  user now exists.
            const { error: retryErr } = await supabase.auth.signInWithOtp({
              email,
              options: { shouldCreateUser: false },
            });
            if (!retryErr) {
              return NextResponse.json(
                { ok: true, message: GENERIC_SUCCESS_MESSAGE },
                { status: 200 },
              );
            }
            console.error(
              '[auth/request-otp] self-heal retry signInWithOtp failed:',
              retryErr.message,
            );
            // Fall through to generic success  -  welcome email was sent, user
            // can click that link to access the PWA.
            return NextResponse.json(
              { ok: true, message: GENERIC_SUCCESS_MESSAGE },
              { status: 200 },
            );
          }
        }

        // No paid order OR createUser fully failed → generic success
        // (do NOT leak account-existence info).
        return NextResponse.json(
          { ok: true, message: GENERIC_SUCCESS_MESSAGE },
          { status: 200 },
        );
      }

      return NextResponse.json({ error: 'Failed to request code' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, message: GENERIC_SUCCESS_MESSAGE }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
