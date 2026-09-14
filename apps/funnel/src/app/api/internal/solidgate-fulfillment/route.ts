import { NextResponse } from 'next/server';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';
import { drainSolidgateCardUpdates } from '@repo/shared/solidgate/card-update-recovery';
import { drainSolidgateSubscriptionTokenSync } from '@repo/shared/solidgate/subscription-token-sync';
import { drainSolidgateFulfillmentOutbox } from '@/lib/payment/solidgate-fulfillment';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const internalMatch = Boolean(
    internalSecret && request.headers.get('x-internal-secret') === internalSecret,
  );
  const cronMatch = Boolean(
    cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`,
  );
  return internalMatch || cronMatch;
}

async function recoverWebhooks(paymentEnvironment: 'production' | 'sandbox') {
  const configuredUrl = process.env.SOLIDGATE_WEBHOOK_RECOVERY_URL?.trim() || undefined;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, '') || undefined;
  if (!configuredUrl && !base) throw new Error('Webhook recovery URL is not configured');
  const url = new URL(configuredUrl ?? `${base}/functions/v1/solidgate-webhooks`);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Webhook recovery requires HTTPS');
  }
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) throw new Error('Webhook recovery secret is not configured');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-solidgate-recovery': '1', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ action: 'recover', expected_environment: paymentEnvironment, limit: 25 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Webhook recovery failed (${response.status})`);
  const result = await response.json();
  if (result.environment !== paymentEnvironment || !Number.isSafeInteger(result.failed)) {
    throw new Error('Unexpected webhook recovery response');
  }
  return result;
}

async function run(request: Request, sweep: boolean) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const paymentEnvironment = currentPaymentEnvironment();
    // Provider callbacks POST for prompt fulfillment. Cron GET also recovers
    // interrupted callbacks/cards, before synchronizing any newly recovered card.
    const errors: string[] = [];
    function settled<T>(name: string, result: PromiseSettledResult<T>): T | null {
      if (result.status === 'fulfilled') return result.value;
      errors.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return null;
    }
    const sweeps = sweep ? await Promise.allSettled([
      recoverWebhooks(paymentEnvironment),
      drainSolidgateCardUpdates({ paymentEnvironment, limit: 10 }),
    ]) : null;
    const webhooks = sweeps ? settled('webhooks', sweeps[0]) : null;
    const cardUpdates = sweeps ? settled('cardUpdates', sweeps[1]) : null;
    // A failure in one independent queue must not block the others.
    const drains = await Promise.allSettled([
      drainSolidgateFulfillmentOutbox(),
      drainSolidgateSubscriptionTokenSync(),
    ]);
    const fulfillment = settled('fulfillment', drains[0]);
    const subscriptionTokenSync = settled('subscriptionTokenSync', drains[1]);
    const ok = errors.length === 0 && !webhooks?.failed && !cardUpdates?.failed && !fulfillment?.failed && !subscriptionTokenSync?.failed;
    return NextResponse.json({ ok, ...fulfillment, subscriptionTokenSync, webhooks, cardUpdates, errors }, { status: ok ? 200 : 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[solidgate-fulfillment]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Supabase webhook/internal trigger. */
export async function POST(request: Request) { return run(request, false); }
/** Vercel Cron recovery sweep, including inbox and abandoned card updates. */
export async function GET(request: Request) { return run(request, true); }
