// D-14: locale breakdown for horizontal bar chart in Locales tab.
// Results sorted desc by count; sharePct = count/total*100 rounded to 1 dp.
// Server-only; never import from 'use client' module.

import { getSupabaseAdminClient } from '@repo/shared/supabase/admin';
import type { DateRange } from './_shared';

export async function sessionsByLocale({
  from,
  to,
}: DateRange): Promise<Array<{ locale: string; count: number; sharePct: number }>> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from('sessions')
    .select('locale')
    .gte('created_at', from)
    .lt('created_at', to);
  if (error || !data) {
    console.error('[admin/locales] sessionsByLocale failed:', error?.message);
    return [];
  }
  const counts = new Map<string, number>();
  for (const row of data) {
    const k = (row.locale as string) ?? 'unknown';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = data.length || 1;
  return [...counts.entries()]
    .map(([locale, count]) => ({
      locale,
      count,
      sharePct: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);
}
