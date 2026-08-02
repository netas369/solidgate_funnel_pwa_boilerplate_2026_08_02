// D-11/D-16/D-17: server-only sessions aggregations.
// All queries use service-role client; live SQL every call (no caching).
// Never import this from a 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import { bucketByDay, type DateRange } from './_shared';

export async function countSessionsInRange({ from, to }: DateRange): Promise<number> {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', from)
    .lt('created_at', to);
  if (error) {
    console.error('[admin/sessions] countSessionsInRange failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

export async function sessionsTimeSeries({
  from,
  to,
}: DateRange): Promise<Array<{ date: string; count: number }>> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('sessions')
    .select('created_at')
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: true });
  if (error || !data) {
    console.error('[admin/sessions] timeSeries failed:', error?.message);
    return [];
  }
  return bucketByDay(data.map((r) => r.created_at as string));
}
