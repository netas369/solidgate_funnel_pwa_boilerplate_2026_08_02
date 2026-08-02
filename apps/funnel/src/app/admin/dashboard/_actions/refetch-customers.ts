'use server';

// Server action for the Customers tab. Re-runs the recent-orders query under
// the cookie identity. Defense-in-depth allowlist re-check before any query,
// same pattern as the sibling refetch-* actions.

import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '../../_queries/_shared';
import { recentOrders } from '../../_queries/customers';
import { RangeSchema } from './_range-schema';

export async function refetchCustomers(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const orders = await recentOrders(range);
  return { orders };
}
