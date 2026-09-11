import { NextResponse } from 'next/server';
import { readSameOriginAdminJson } from '@repo/admin-core/request';
import { getAuthenticatedAdminUser } from '@/app/admin/_queries/admin-access';
import { normalizeSupportEmail } from '@/features/admin/support/format';
import { supabaseSolidgateSupportAdapter } from '@/features/admin/adapters/supabase-solidgate';
import { consumeAdminRateLimit } from '@/features/admin/rate-limit';
import { adminConfig } from '@/admin.config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 2_048;

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

export async function POST(request: Request) {
  const parsed = await readSameOriginAdminJson(request, MAX_BODY_BYTES);
  if (!parsed.ok) return privateJson({ error: parsed.error }, parsed.status);

  const actor = await getAuthenticatedAdminUser('support:view');
  if (!actor) {
    return privateJson({ error: 'Administrator authorization required.' }, 401);
  }
  if (supabaseSolidgateSupportAdapter.id !== adminConfig.support.adapter) {
    return privateJson({ error: 'The configured support adapter is unavailable.' }, 503);
  }

  const rateLimit = await consumeAdminRateLimit({
    subject: actor.id,
    scope: 'support_lookup',
    ...adminConfig.support.lookupRateLimit,
  });
  if (!rateLimit.allowed) {
    return privateJson(
      {
        error: rateLimit.unavailable
          ? 'Support request protection is unavailable.'
          : 'Too many support lookups. Try again shortly.',
      },
      rateLimit.unavailable ? 503 : 429,
    );
  }

  const normalized = normalizeSupportEmail(parsed.body.email);
  if (!normalized.ok) return privateJson({ error: normalized.error }, 400);

  try {
    const report = await supabaseSolidgateSupportAdapter.lookupExactEmail(
      normalized.email,
      adminConfig,
    );
    return privateJson({ report });
  } catch (error) {
    console.error('[admin/support] lookup failed:',
      error instanceof Error ? error.message : 'unknown error');
    return privateJson(
      { error: 'The customer report could not be generated. Try again in a moment.' },
      500,
    );
  }
}

export async function GET() {
  return privateJson({ error: 'Method not allowed.' }, 405);
}
