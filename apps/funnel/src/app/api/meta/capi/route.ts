import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { paymentEnvironmentForVercel } from '@repo/shared/payment-environment';
import { verifyPaymentCookie, PAYMENT_COOKIE_NAME } from '@repo/shared/payment-cookie';
import { sendMetaCapiEvent, hashMetaEmail } from '@/features/analytics/lib/meta-capi';
import { purchaseEventValue } from '@/features/analytics/lib/purchase-value';

const ALLOWED_EVENTS = new Set(['Lead', 'AddToCart', 'InitiateCheckout', 'Purchase', 'StartTrial']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{8,255}$/;
const ACTIVE_ORDER_STATUSES = new Set(['completed', 'trialing', 'active']);

type CapiRequestBody = {
  eventName?: unknown;
  eventId?: unknown;
  sessionId?: unknown;
  eventSourceUrl?: unknown;
  email?: unknown;
  customData?: {
    value?: unknown;
    currency?: unknown;
    content_ids?: unknown;
    content_type?: unknown;
  };
};

function extractClientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip')?.trim() || null;
}

function analyticsEnvironment(): 'production' | 'preview' | 'development' {
  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') return 'preview';
  return 'development';
}

function hashIp(ip: string): string {
  const secret = process.env.PAYMENT_COOKIE_SECRET;
  if (!secret) throw new Error('PAYMENT_COOKIE_SECRET env var is not set');
  return createHmac('sha256', secret).update(ip).digest('hex');
}

function safeSourceUrl(req: NextRequest, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const source = new URL(value);
    const allowedOrigins = new Set([req.nextUrl.origin]);
    const configured = process.env.NEXT_PUBLIC_FUNNEL_URL;
    if (configured) allowedOrigins.add(new URL(configured).origin);
    return allowedOrigins.has(source.origin) ? source.toString() : undefined;
  } catch {
    return undefined;
  }
}

function validClientCustomData(body: CapiRequestBody['customData']) {
  if (!body) return undefined;
  const value =
    typeof body.value === 'number' && Number.isFinite(body.value) && body.value >= 0
      ? body.value
      : undefined;
  const currency =
    typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency)
      ? body.currency.toUpperCase()
      : undefined;
  const contentIds = Array.isArray(body.content_ids)
    ? body.content_ids
        .filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item))
        .slice(0, 10)
    : undefined;
  return {
    value,
    currency,
    content_ids: contentIds?.length ? contentIds : undefined,
    content_type: 'product',
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestOrigin = req.headers.get('origin');
  if (!requestOrigin || safeSourceUrl(req, requestOrigin) === undefined) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }

  let body: CapiRequestBody;
  try {
    body = (await req.json()) as CapiRequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (
    typeof body.eventName !== 'string' ||
    !ALLOWED_EVENTS.has(body.eventName) ||
    typeof body.eventId !== 'string' ||
    !EVENT_ID_PATTERN.test(body.eventId) ||
    typeof body.sessionId !== 'string' ||
    !UUID_PATTERN.test(body.sessionId)
  ) {
    return NextResponse.json({ error: 'invalid_event' }, { status: 400 });
  }

  const clientIp = extractClientIp(req);
  if (!clientIp) {
    return NextResponse.json({ error: 'client_ip_unavailable' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, email')
    .eq('id', body.sessionId)
    .maybeSingle();
  if (sessionError) {
    console.error('[meta-capi] session lookup failed:', sessionError.message);
    return NextResponse.json({ error: 'verification_unavailable' }, { status: 503 });
  }
  if (!session) {
    return NextResponse.json({ error: 'unknown_session' }, { status: 403 });
  }

  const email = session.email ?? undefined;
  let customData = validClientCustomData(body.customData);

  if (body.eventName === 'Purchase' || body.eventName === 'StartTrial') {
    const prefix = 'purchase:';
    if (!body.eventId.startsWith(prefix)) {
      return NextResponse.json({ error: 'invalid_purchase_id' }, { status: 400 });
    }
    const orderId = body.eventId.slice(prefix.length);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('session_id, amount_cents, currency, product_slug, status, solidgate_subscription_id')
      .eq('payment_environment', paymentEnvironmentForVercel(process.env.VERCEL_ENV))
      .eq('solidgate_order_id', orderId)
      .maybeSingle();
    if (orderError) {
      console.error('[meta-capi] order lookup failed:', orderError.message);
      return NextResponse.json({ error: 'verification_unavailable' }, { status: 503 });
    }
    // Purchase must be a captured positive charge; StartTrial must be a real
    // zero-amount subscription (only the retired auth_0_amount flows opened
    // one — special_free settles €1 since 2026-07-29) — the browser cannot
    // relabel a paid order as a trial or vice versa.
    const verified =
      order &&
      order.session_id === body.sessionId &&
      ACTIVE_ORDER_STATUSES.has(order.status) &&
      (body.eventName === 'Purchase'
        ? order.amount_cents > 0
        : order.amount_cents === 0 && Boolean(order.solidgate_subscription_id));
    if (!verified) {
      return NextResponse.json({ error: 'unverified_purchase' }, { status: 403 });
    }

    const signedCookie = req.cookies.get(PAYMENT_COOKIE_NAME)?.value;
    const paymentAccess = signedCookie ? await verifyPaymentCookie(signedCookie) : null;
    if (!paymentAccess || paymentAccess.sessionId !== body.sessionId) {
      return NextResponse.json({ error: 'payment_access_required' }, { status: 403 });
    }

    // Revenue fields always come from the settled server-side order, never
    // from a browser-provided amount or currency.
    customData = {
      value: purchaseEventValue(order.amount_cents, order.currency),
      currency: order.currency.toUpperCase(),
      content_ids: order.product_slug ? [order.product_slug] : undefined,
      content_type: 'product',
    };
  }

  const { data: claimed, error: claimError } = await supabase.rpc('claim_meta_capi_event', {
    p_environment: analyticsEnvironment(),
    p_event_name: body.eventName,
    p_event_id: body.eventId,
    p_ip_hash: hashIp(clientIp),
    p_session_id: body.sessionId,
    p_window_seconds: 600,
    p_max_events: 40,
  });
  if (claimError) {
    console.error('[meta-capi] claim failed:', claimError.message);
    return NextResponse.json({ error: 'ingress_unavailable' }, { status: 503 });
  }
  if (!claimed) {
    // Covers both a duplicate event ID and a throttled IP without exposing
    // which guard fired. In either case nothing should be forwarded to Meta.
    return NextResponse.json({ ok: true, accepted: false }, { status: 202 });
  }

  const event = {
    eventName: body.eventName,
    eventId: body.eventId,
    eventSourceUrl: safeSourceUrl(req, body.eventSourceUrl),
    userData: {
      em: email ? hashMetaEmail(email) : undefined,
      fbp: req.cookies.get('_fbp')?.value,
      fbc: req.cookies.get('_fbc')?.value,
      client_ip_address: clientIp,
      client_user_agent: req.headers.get('user-agent') ?? undefined,
    },
    customData,
  };

  // A retry is safe because Meta deduplicates on (event_name, event_id).
  let ok = await sendMetaCapiEvent(event);
  if (!ok) ok = await sendMetaCapiEvent(event);

  if (!ok) {
    // Release the claim so a later browser retry or operational replay is not
    // permanently suppressed by a transient Meta/configuration failure.
    await supabase
      .from('meta_capi_event_claims')
      .delete()
      .eq('environment', analyticsEnvironment())
      .eq('event_name', body.eventName)
      .eq('event_id', body.eventId);
    return NextResponse.json({ ok: false, accepted: false }, { status: 503 });
  }

  return NextResponse.json({ ok, accepted: true });
}
