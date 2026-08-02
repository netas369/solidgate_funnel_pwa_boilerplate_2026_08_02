// Recent buyers — server-only query for the admin Customers tab.
// Lists orders (subscriptions and one-time purchases) newest-first, with the
// buyer's email + locale resolved from the originating quiz session.
// Never import this from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { DateRange } from './_shared';

export interface CustomerOrderRow {
  id: string;
  /** ISO timestamp the order was created. */
  createdAt: string;
  /** Buyer email from the originating session; null if none on file. */
  email: string | null;
  locale: string | null;
  productName: string;
  /** Order status (active, trialing, past_due, canceled, completed, …). */
  status: string;
  amountCents: number;
  currency: string;
  /** The Solidgate subscription id when the order is a subscription. */
  subscriptionId: string | null;
  /** True when the order carries a subscription id. */
  isSubscription: boolean;
}

/** Default cap on the recent-orders table. */
const DEFAULT_LIMIT = 200;

/** Read the email/locale off a PostgREST embedded `sessions` relation. */
function embeddedSession(value: unknown): {
  email: string | null;
  locale: string | null;
} {
  const s = Array.isArray(value) ? value[0] : value;
  const obj = (s ?? null) as {
    email?: string | null;
    locale?: string | null;
  } | null;
  return { email: obj?.email ?? null, locale: obj?.locale ?? null };
}

export async function recentOrders(
  { from, to }: DateRange,
  limit: number = DEFAULT_LIMIT,
): Promise<CustomerOrderRow[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('orders')
    .select(
      'id, created_at, status, product_name, amount_cents, currency, solidgate_subscription_id, sessions(email, locale)',
    )
    .eq('payment_environment', 'production')
    // Solidgate writes the order row BEFORE payment, so 'pending' means an
    // opened checkout, not a buyer — and every decline-retry mints a fresh
    // order. Hide them or the tab fills with abandoned attempts.
    .neq('status', 'pending')
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) {
    console.error('[admin/customers] recentOrders failed:', error?.message);
    return [];
  }
  return data.map((row) => {
    const sess = embeddedSession((row as { sessions?: unknown }).sessions);
    const subId = (row.solidgate_subscription_id as string | null) ?? null;
    return {
      id: row.id as string,
      createdAt: row.created_at as string,
      email: sess.email,
      locale: sess.locale,
      productName: (row.product_name as string) ?? '',
      status: (row.status as string) ?? '',
      amountCents: (row.amount_cents as number) ?? 0,
      currency: (row.currency as string) ?? 'eur',
      subscriptionId: subId,
      isSubscription: subId != null,
    };
  });
}
