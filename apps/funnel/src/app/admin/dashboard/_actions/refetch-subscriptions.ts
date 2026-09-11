'use server';

// Server action for the Subscriptions tab. Returns the cohort + rolling
// trial-to-paid conversion, locale performance, and recurring-OTO snapshot.
// Same defense-in-depth pattern as siblings.

import { createClient } from '@repo/shared/supabase/server';
import { adminEmailHasCapability } from '../../_queries/_shared';
import {
  paidConversionsCohort,
  paidConversionsRolling,
  recurringOtoSnapshot,
  subscriptionPerformanceByLocale,
  subscriptionStatusBreakdown,
  subscriptionVariantBreakdown,
} from '../../_queries/subscriptions';
import { RangeSchema } from './_range-schema';

export async function refetchSubscriptions(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!adminEmailHasCapability(user?.email, 'analytics:view')) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const [
    cohort,
    rolling,
    recurringOto,
    statusBreakdown,
    variantBreakdown,
    localePerformance,
  ] = await Promise.all([
    paidConversionsCohort(range),
    paidConversionsRolling(range),
    recurringOtoSnapshot(range),
    subscriptionStatusBreakdown(range),
    subscriptionVariantBreakdown(range),
    subscriptionPerformanceByLocale(range),
  ]);
  return {
    cohort,
    rolling,
    recurringOto,
    statusBreakdown,
    variantBreakdown,
    localePerformance,
  };
}
