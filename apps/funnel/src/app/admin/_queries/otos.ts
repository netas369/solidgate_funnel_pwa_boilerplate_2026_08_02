// OTO offer aggregations for the admin OTOs tab.
// OTO_OFFERS is derived at module load from the Solidgate catalog's oto* slugs,
// so adding or renaming an upsell is a catalog edit — never an edit here.
// Revenue per offer is converted to EUR via fx.convertToEur.
// Server-only; never import from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { PRODUCT_ID_TO_CODE } from '@repo/shared/solidgate/catalog';
import { z } from 'zod';
import { financialReport, sumInEur } from './revenue';
import type { DateRange } from './_shared';

export interface OtoMetric {
  offer: string;
  /** The catalog offering code matched on orders.product_slug. */
  pattern: string;
  count: number;
  amountEurCents: number | null;
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

export async function otoCountsPerOffer(range: DateRange): Promise<OtoMetric[]> {
  const [report, counts] = await Promise.all([
    financialReport(range),
    getSupabaseAdminClient().rpc('get_solidgate_purchase_counts', {
      p_environment: 'production', p_from: range.from, p_to: range.to, p_products: OTO_OFFERS.map(row => row.code),
    }),
  ]);
  if (counts.error) throw new Error(`Purchase report unavailable: ${counts.error.message}`);
  const rows = z.array(z.object({ product_slug: z.string(), count: z.number().int().nonnegative().safe() })).parse(counts.data);
  return OTO_OFFERS.map(({ offer, code }) => ({ offer, pattern: code,
    count: rows.find(row => row.product_slug === code)?.count ?? 0,
    amountEurCents: sumInEur(report.rows.filter(row => row.billing_type === 'initial' && row.product_slug === code)),
  }));
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
    const { count: viewed, error } = await admin
      .from('funnel_events')
      .select('*', { count: 'exact', head: true })
      .ilike('event_type', `%${offer}%`)
      .gte('created_at', from)
      .lt('created_at', to);
    if (error) throw new Error(`Offer views unavailable: ${error.message}`);
    const purchases = counts.find((c) => c.offer === offer)?.count ?? 0;
    const denom = viewed ?? 0;
    results.push({ offer, takeRate: denom > 0 ? purchases / denom : 0 });
  }
  return results;
}
