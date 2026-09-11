'use server';

// D-19: Server action for the Revenue tab. Same defense-in-depth pattern as
// refetch-sessions: createClient + getUser + isAdminEmail re-check, then
// RangeSchema.parse, then parallel queries via Promise.all.

import { createClient } from '@repo/shared/supabase/server';
import { adminEmailHasCapability } from '../../_queries/_shared';
import { RangeSchema } from './_range-schema';
import { supabaseSolidgateRevenueAdapter } from '@/features/admin/adapters/supabase-solidgate';
import { adminConfig } from '@/admin.config';

export async function refetchRevenue(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!adminEmailHasCapability(user?.email, 'analytics:view')) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  return supabaseSolidgateRevenueAdapter.readSnapshot(range, adminConfig);
}
