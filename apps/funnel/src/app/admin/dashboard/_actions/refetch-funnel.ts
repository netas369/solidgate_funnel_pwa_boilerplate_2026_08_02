'use server';

// Server action invoked by FunnelClient when the date-range picker is applied.
// Defense-in-depth allowlist re-check: proxy.ts already gates /admin/* but
// server actions can be called from any path with a valid cookie, so we
// re-verify isAdminEmail BEFORE running queries (mirrors refetch-sessions.ts).

import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '../../_queries/_shared';
import {
  quizStepFunnel,
  funnelStageSummary,
  localeBreakdown,
} from '../../_queries/funnel';
import { RangeSchema } from './_range-schema';

export async function refetchFunnel(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const [steps, summary, byLocale] = await Promise.all([
    quizStepFunnel(range),
    funnelStageSummary(range),
    localeBreakdown(range),
  ]);
  return { steps, summary, byLocale };
}
