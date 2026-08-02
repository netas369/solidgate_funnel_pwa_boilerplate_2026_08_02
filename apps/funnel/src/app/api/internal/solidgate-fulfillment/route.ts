import { NextResponse } from 'next/server';
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

async function run(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const [fulfillment, subscriptionTokenSync] = await Promise.all([
      drainSolidgateFulfillmentOutbox(),
      drainSolidgateSubscriptionTokenSync(),
    ]);
    return NextResponse.json({ ok: true, ...fulfillment, subscriptionTokenSync });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[solidgate-fulfillment]', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/** Supabase webhook/internal trigger. */
export async function POST(request: Request) {
  return run(request);
}

/** Vercel Cron recovery sweep for jobs whose immediate trigger was interrupted. */
export async function GET(request: Request) {
  return run(request);
}
