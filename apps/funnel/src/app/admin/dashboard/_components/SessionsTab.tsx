// D-15 + D-19: Server Component that fetches initial 30d sessions snapshot
// in parallel and hands it to <SessionsClient/>. The client wrapper owns
// the date-range state and subsequent re-fetches via refetch-sessions action.
// Single Suspense boundary in page.tsx wraps this async component.

import { subDays, startOfDay, formatISO } from 'date-fns';
import { sessionsTimeSeries } from '../../_queries/sessions';
import { sessionsByLocale } from '../../_queries/locales';
import { SessionsClient } from './SessionsClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function SessionsTab() {
  const range = default30dRange();
  const [timeSeries, byLocale] = await Promise.all([
    sessionsTimeSeries(range),
    sessionsByLocale(range),
  ]);
  return <SessionsClient initialData={{ timeSeries, byLocale }} />;
}
