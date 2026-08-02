'use server';

// D-19: Server action for the Revenue tab. Same defense-in-depth pattern as
// refetch-sessions: createClient + getUser + isAdminEmail re-check, then
// RangeSchema.parse, then parallel queries via Promise.all.

import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '../../_queries/_shared';
import {
  grossRevenueInEurInRange,
  revenueByCurrencyInRange,
  renewalRevenueInEur,
  revenueTimeSeriesInEur,
} from '../../_queries/revenue';
import { RangeSchema } from './_range-schema';

export async function refetchRevenue(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const [oneTimeEur, renewalEur, byCurrency, timeSeries] = await Promise.all([
    grossRevenueInEurInRange(range),
    renewalRevenueInEur(range),
    revenueByCurrencyInRange(range),
    revenueTimeSeriesInEur(range),
  ]);
  return { oneTimeEur, renewalEur, byCurrency, timeSeries };
}
