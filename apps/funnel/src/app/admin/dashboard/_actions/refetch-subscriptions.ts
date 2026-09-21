'use server';

// Server action for the Subscriptions tab. Returns the cohort + rolling
// trial-to-paid conversion and the recurring-OTO active snapshot.
// Same defense-in-depth pattern as siblings.

import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '../../_queries/_shared';
import { subscriptionsSummaryInRange } from '../../_queries/subscriptions';
import { RangeSchema } from './_range-schema';

export async function refetchSubscriptions(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  return subscriptionsSummaryInRange(range);
}
