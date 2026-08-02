// Server Component that fetches the initial 30d quiz-funnel snapshot in
// parallel and hands it to <FunnelClient/>. The client wrapper owns the
// date-range state and re-fetches via the refetch-funnel action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import {
  quizStepFunnel,
  funnelStageSummary,
  localeBreakdown,
} from '../../_queries/funnel';
import { FunnelClient } from './FunnelClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function FunnelTab() {
  const range = default30dRange();
  const [steps, summary, byLocale] = await Promise.all([
    quizStepFunnel(range),
    funnelStageSummary(range),
    localeBreakdown(range),
  ]);
  return <FunnelClient initialData={{ steps, summary, byLocale }} />;
}
