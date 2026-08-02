import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authorizePaymentSessionAccess } from '@repo/shared/payment-session-access';
import { productKeyFromSlug, type ProductKey } from '@repo/shared/oto-product-label';
import { currentPaymentEnvironment } from '@repo/shared/payment-environment';

/**
 * POST /api/orders/session-summary
 *
 * Returns the completed orders for a funnel session, mapped onto stable
 * display keys, for the OTO-8 summary page ("everything you purchased").
 *
 * Body: { sessionId: string }
 * Auth: same gate as the OTO charge routes — the requester must own the
 *       session (authenticated account) or hold a valid payment cookie.
 *
 * Response: { orders: Array<{ productKey, amountCents, currency }> }
 *   One line per distinct product family, in purchase order.
 */

const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getSupabaseServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface OrderRow {
  product_slug: string | null;
  amount_cents: number | null;
  currency: string | null;
  created_at: string | null;
}

interface SummaryItem {
  productKey: ProductKey;
  amountCents: number;
  currency: string;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { sessionId } = body as { sessionId?: unknown };

    if (typeof sessionId !== 'string' || !SESSION_UUID_PATTERN.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }

    const supabase = getSupabaseServiceClient();

    const { data: session, error: sessionErr } = await supabase
      .from('sessions')
      .select('user_id')
      .eq('id', sessionId)
      .single();

    if (sessionErr || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const sessionRow = session as { user_id: string | null };

    const access = await authorizePaymentSessionAccess({
      requestedSessionId: sessionId,
      sessionUserId: sessionRow.user_id,
      // Deprecated arg: the gate verifies the payment cookie's order id
      // against the orders table instead.
      sessionPaymentIntentId: null,
    });
    if (!access.ok) return access.response;

    // 'completed' covers one-time charges (the intro fee + one-time OTOs);
    // 'trialing' and 'active' cover recurring subscriptions (the main product
    // and any subscription OTO), which never reach a 'completed' status.
    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('product_slug, amount_cents, currency, created_at')
      .eq('payment_environment', currentPaymentEnvironment())
      .eq('session_id', sessionId)
      .in('status', ['completed', 'active', 'trialing'])
      .order('created_at', { ascending: true });

    if (ordersErr) {
      console.error('[orders/session-summary] query error:', ordersErr.message);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    // Collapse to one line per product family (the first order wins), preserving
    // purchase order. Guards against duplicate rows from charge retries.
    const seen = new Set<ProductKey>();
    const items: SummaryItem[] = [];
    for (const row of (orders ?? []) as OrderRow[]) {
      const productKey = productKeyFromSlug(row.product_slug);
      if (productKey === 'unknown' || seen.has(productKey)) continue;
      if (typeof row.amount_cents !== 'number' || !row.currency) continue;
      seen.add(productKey);
      items.push({
        productKey,
        amountCents: row.amount_cents,
        currency: row.currency,
      });
    }

    return NextResponse.json({ orders: items });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[orders/session-summary] unexpected error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
