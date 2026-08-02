// D-11 + D-19: Server Component that fetches initial 30d OTO snapshot
// (counts + take rates) in parallel and hands it to <OtosClient/>. The
// client wrapper owns the date-range state and re-fetches via refetch-otos
// action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import { otoCountsPerOffer, otoTakeRates } from '../../_queries/otos';
import { OtosClient } from './OtosClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function OtosTab() {
  const range = default30dRange();
  const [counts, rates] = await Promise.all([
    otoCountsPerOffer(range),
    otoTakeRates(range),
  ]);
  return <OtosClient initialData={{ counts, rates }} />;
}
