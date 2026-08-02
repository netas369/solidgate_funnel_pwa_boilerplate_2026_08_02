'use server';

// D-19: Server action invoked by SessionsClient when the date-range picker
// is applied. Defense-in-depth allowlist re-check (RESEARCH.md Pattern 4 step 4)
// — proxy.ts already gates /admin/* but server actions can be called from any
// path with a valid cookie, so we re-verify isAdminEmail BEFORE running queries.
// (T-06-01 mitigation enforced by refetch-sessions.test.ts.)

import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from '../../_queries/_shared';
import { sessionsTimeSeries } from '../../_queries/sessions';
import { sessionsByLocale } from '../../_queries/locales';
import { RangeSchema } from './_range-schema';

export async function refetchSessions(input: unknown) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) {
    throw new Error('Forbidden');
  }
  const range = RangeSchema.parse(input);
  const [timeSeries, byLocale] = await Promise.all([
    sessionsTimeSeries(range),
    sessionsByLocale(range),
  ]);
  return { timeSeries, byLocale };
}
