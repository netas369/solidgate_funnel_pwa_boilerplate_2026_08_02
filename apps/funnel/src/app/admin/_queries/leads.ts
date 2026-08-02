// D-11/D-16/D-17: server-only lead-count aggregation.
// Filters funnel_events to event_type='lead_captured' (D-09 contract).
// Never import this from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { DateRange } from './_shared';

export async function countLeadsInRange({ from, to }: DateRange): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('funnel_events')
    .select('*', { count: 'exact', head: true })
    .eq('event_type', 'lead_captured')
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error('[admin/leads] countLeadsInRange failed:', error.message);
    return 0;
  }
  return count ?? 0;
}
