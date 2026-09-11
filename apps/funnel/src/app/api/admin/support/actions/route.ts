import { createHash } from 'node:crypto';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { readSameOriginAdminJson } from '@repo/admin-core/request';
import { getAuthenticatedAdminUser } from '@/app/admin/_queries/admin-access';
import { normalizeSupportEmail } from '@/features/admin/support/format';
import type { SupportActionName } from '@/features/admin/support/types';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { Database, Json } from '@repo/shared/types/database';
import { consumeAdminRateLimit } from '@/features/admin/rate-limit';
import { adminConfig } from '@/admin.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function isSupportAction(value: unknown): value is SupportActionName {
  return (
    typeof value === 'string' &&
    adminConfig.support.enabledActions.includes(value as SupportActionName)
  );
}

async function finishAudit(
  auditId: string,
  outcome: 'success' | 'failed' | 'refused',
  details: Json,
) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin
    .from('support_action_audit')
    .update({ outcome, details, completed_at: new Date().toISOString() })
    .eq('id', auditId);
  if (error) {
    console.error('[admin/support] audit completion failed:', error.message);
  }
}

export async function POST(request: Request) {
  const parsed = await readSameOriginAdminJson(request, MAX_BODY_BYTES);
  if (!parsed.ok) return privateJson({ error: parsed.error }, parsed.status);

  const actor = await getAuthenticatedAdminUser('support:act');
  if (!actor) return privateJson({ error: 'Administrator authorization required.' }, 401);

  const body = parsed.body;
  if (!isSupportAction(body.action)) {
    return privateJson({ error: 'Unsupported support action.' }, 400);
  }
  if (body.confirm !== true) {
    return privateJson({ error: 'Explicit confirmation is required.' }, 400);
  }
  if (typeof body.idempotencyKey !== 'string' || !UUID_PATTERN.test(body.idempotencyKey)) {
    return privateJson({ error: 'A valid idempotency key is required.' }, 400);
  }

  const rateLimit = await consumeAdminRateLimit({
    subject: actor.id,
    scope: 'support_action',
    ...adminConfig.support.actionRateLimit,
  });
  if (!rateLimit.allowed) {
    return privateJson(
      {
        error: rateLimit.unavailable
          ? 'Support request protection is unavailable.'
          : 'Too many support actions. Try again shortly.',
      },
      rateLimit.unavailable ? 503 : 429,
    );
  }

  const normalized = normalizeSupportEmail(body.email);
  if (!normalized.ok) return privateJson({ error: normalized.error }, 400);

  const admin = getSupabaseAdminClient();
  const emailHash = createHash('sha256').update(normalized.email).digest('hex');
  const { data: customerUserId, error: identityError } = await admin.rpc(
    'find_auth_user_id_by_email',
    { p_email: normalized.email },
  );
  if (identityError) {
    return privateJson({ error: 'The customer identity is ambiguous or unavailable.' }, 409);
  }
  if (!customerUserId) {
    return privateJson({ error: 'No registered account exists for this email.' }, 404);
  }

  const { data: customerResult, error: customerError } =
    await admin.auth.admin.getUserById(customerUserId);
  const customer = customerResult.user;
  if (
    customerError ||
    !customer?.email ||
    customer.email.trim().toLowerCase() !== normalized.email
  ) {
    return privateJson({ error: 'The customer identity could not be verified.' }, 409);
  }

  const { data: audit, error: auditError } = await admin
    .from('support_action_audit')
    .insert({
      action: body.action,
      idempotency_key: body.idempotencyKey,
      customer_email_hash: emailHash,
      customer_user_id: customer.id,
      actor_user_id: actor.id,
      outcome: 'started',
      details: {},
    })
    .select('id')
    .single();
  if (auditError || !audit) {
    if (auditError?.code === '23505') {
      return privateJson(
        { error: 'This support action was already submitted.' },
        409,
      );
    }
    console.error('[admin/support] audit start failed:', auditError?.message);
    return privateJson(
      { error: 'The audit trail could not be started, so no action was performed.' },
      503,
    );
  }

  if (body.action === 'revoke_sessions' && actor.id === customer.id) {
    await finishAudit(audit.id, 'refused', { reason: 'self_revocation' });
    return privateJson({ error: 'You cannot revoke your own active admin sessions here.' }, 409);
  }

  if (body.action === 'send_login_code') {
    const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!publicUrl || !anonKey) {
      await finishAudit(audit.id, 'failed', { reason: 'auth_not_configured' });
      return privateJson({ error: 'Authentication email is not configured.' }, 503);
    }

    const authClient = createSupabaseClient<Database>(publicUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { error } = await authClient.auth.signInWithOtp({
      email: normalized.email,
      options: { shouldCreateUser: false },
    });
    if (error) {
      await finishAudit(audit.id, 'failed', {
        reason: 'auth_provider_rejected',
        status: error.status ?? 500,
      });
      return privateJson({ error: 'The login code could not be sent.' }, 502);
    }

    await finishAudit(audit.id, 'success', { delivered: true });
    console.info('[admin/support] action complete', {
      action: body.action,
      customer: emailHash.slice(0, 12),
      actor: actor.id,
    });
    return privateJson({
      result: {
        action: body.action,
        message: `A one-time login code was sent to ${normalized.email}.`,
      },
    });
  }

  const { data: revokedCount, error: revokeError } = await admin.rpc(
    'revoke_user_auth_sessions',
    { p_user_id: customer.id },
  );
  if (revokeError) {
    await finishAudit(audit.id, 'failed', { reason: 'session_revocation_failed' });
    return privateJson({ error: 'Customer sessions could not be revoked.' }, 503);
  }

  await finishAudit(audit.id, 'success', { revokedSessions: revokedCount ?? 0 });
  console.info('[admin/support] action complete', {
    action: body.action,
    customer: emailHash.slice(0, 12),
    actor: actor.id,
  });
  return privateJson({
    result: {
      action: body.action,
      message: `Revoked ${revokedCount ?? 0} active customer session${revokedCount === 1 ? '' : 's'}.`,
    },
  });
}

export async function GET() {
  return privateJson({ error: 'Method not allowed.' }, 405);
}
