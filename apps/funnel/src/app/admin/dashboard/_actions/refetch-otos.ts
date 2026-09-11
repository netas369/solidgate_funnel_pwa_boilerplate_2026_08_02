'use server';

// D-19: Server action for the OTOs tab. Returns per-offer counts + take rates.
// Same defense-in-depth pattern as siblings.

import { createClient } from '@repo/shared/supabase/server';
import { adminEmailHasCapability } from '../../_queries/_shared';
import { otoCountsPerOffer, otoTakeRates } from '../../_queries/otos';
import { RangeSchema } from './_range-schema';

export async function refetchOtos(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!adminEmailHasCapability(user?.email, 'analytics:view')) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const [counts, rates] = await Promise.all([
    otoCountsPerOffer(range),
    otoTakeRates(range),
  ]);
  return { counts, rates };
}
