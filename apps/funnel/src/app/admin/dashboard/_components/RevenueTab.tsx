// D-22 + D-19: Server Component that fetches initial 30d revenue snapshot
// in parallel and hands it to <RevenueClient/>. The client wrapper owns the
// date-range state and re-fetches via refetch-revenue action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import {
  grossRevenueInEurInRange,
  revenueByCurrencyInRange,
  renewalRevenueInEur,
  revenueTimeSeriesInEur,
} from '../../_queries/revenue';
import { RevenueClient } from './RevenueClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function RevenueTab() {
  const range = default30dRange();
  const [oneTimeEur, renewalEur, byCurrency, timeSeries] = await Promise.all([
    grossRevenueInEurInRange(range),
    renewalRevenueInEur(range),
    revenueByCurrencyInRange(range),
    revenueTimeSeriesInEur(range),
  ]);
  return (
    <RevenueClient
      initialData={{ oneTimeEur, renewalEur, byCurrency, timeSeries }}
    />
  );
}
