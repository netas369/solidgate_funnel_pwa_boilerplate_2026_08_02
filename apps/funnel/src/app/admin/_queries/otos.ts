// OTO offer aggregations for the admin OTOs tab.
// OTO_OFFERS is derived at module load from the Solidgate catalog's oto* slugs,
// so adding or renaming an upsell is a catalog edit — never an edit here.
// Revenue per offer is converted to EUR via fx.convertToEur.
// Server-only; never import from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { PRODUCT_ID_TO_CODE } from '@repo/shared/solidgate/catalog';
import type { ProductId } from '@repo/shared/price-map';
import { convertToEur } from './fx';
import type { DateRange } from './_shared';

export interface OtoMetric {
  offer: string;
  /** The catalog offering code matched on orders.product_slug. */
  pattern: string;
  count: number;
  amountEurCents: number;
}

// Map every oto* slug to its full catalog offering code. Solidgate writes that
// exact code into orders.product_slug, so the match is an equality, NOT a
// substring: sibling codes share prefixes (BUNDLE / BUNDLE1 / BUNDLE2 …) and a
// LIKE '%BUNDLE%' would silently fold three offers into one.
const OTO_OFFERS: Array<{ offer: string; code: string }> = Object.entries(
  PRODUCT_ID_TO_CODE,
)
  .filter(([slug]) => slug.startsWith('oto'))
  .map(([slug, code]) => ({ offer: slug, code }));

// Subscription OTOs never reach 'completed' — their order lives as
// trialing → active → past_due → canceled, and a sub start IS a take. Their
// recurring revenue is reported separately by recurringOtoSnapshot
// (renewal_events), so here only the order's own amount counts (the intro
// charge, 0 for a free trial) — no double counting.
//
// TODO(new product): list every upsell slot that starts a subscription.
// Typed as ProductId so a catalog rename fails the build instead of silently
// mis-bucketing the offer.
const SUBSCRIPTION_OFFERS = new Set<ProductId>(['oto2_addon_weekly']);
const SUB_TAKE_STATUSES = ['trialing', 'active', 'past_due', 'canceled'];

export async function otoCountsPerOffer({ from, to }: DateRange): Promise<OtoMetric[]> {
  const admin = getSupabaseAdminClient();
  const results: OtoMetric[] = [];
  for (const { offer, code } of OTO_OFFERS) {
    const base = admin
      .from('orders')
      .select('amount_cents,currency')
      .eq('payment_environment', 'production');
    const withStatus = SUBSCRIPTION_OFFERS.has(offer as ProductId)
      ? base.in('status', SUB_TAKE_STATUSES)
      : base.eq('status', 'completed');
    const { data, error } = await withStatus
      .eq('product_slug', code)
      .gte('created_at', from)
      .lt('created_at', to);
    if (error || !data) {
      console.error(`[admin/otos] count failed for ${offer}:`, error?.message);
      results.push({ offer, pattern: code, count: 0, amountEurCents: 0 });
      continue;
    }
    const amountEurCents = data.reduce(
      (sum, row) =>
        sum +
        convertToEur(
          (row.amount_cents as number) ?? 0,
          (row.currency as string) ?? 'eur',
        ),
      0,
    );
    results.push({ offer, pattern: code, count: data.length, amountEurCents });
  }
  return results;
}

export async function otoTakeRates({
  from,
  to,
}: DateRange): Promise<Array<{ offer: string; takeRate: number }>> {
  const admin = getSupabaseAdminClient();
  const counts = await otoCountsPerOffer({ from, to });
  const results: Array<{ offer: string; takeRate: number }> = [];
  for (const { offer } of OTO_OFFERS) {
    // Use funnel_events with event_type containing the offer slug as a tighter
    // denominator than total sessions (RESEARCH.md recommendation). takeRate=0
    // when no events matched (avoid NaN).
    const { count: viewed } = await admin
      .from('funnel_events')
      .select('*', { count: 'exact', head: true })
      .ilike('event_type', `%${offer}%`)
      .gte('created_at', from)
      .lt('created_at', to);
    const purchases = counts.find((c) => c.offer === offer)?.count ?? 0;
    const denom = viewed ?? 0;
    results.push({ offer, takeRate: denom > 0 ? purchases / denom : 0 });
  }
  return results;
}
