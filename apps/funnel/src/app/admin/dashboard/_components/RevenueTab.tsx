// D-22 + D-19: Server Component that fetches initial 30d revenue snapshot
// in parallel and hands it to <RevenueClient/>. The client wrapper owns the
// date-range state and re-fetches via refetch-revenue action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import { RevenueClient } from './RevenueClient';
import { supabaseSolidgateRevenueAdapter } from '@/features/admin/adapters/supabase-solidgate';
import { adminConfig } from '@/admin.config';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function RevenueTab() {
  const range = default30dRange();
  const result = await supabaseSolidgateRevenueAdapter.readSnapshot(range, adminConfig);
  return <RevenueClient initialData={result} />;
}
