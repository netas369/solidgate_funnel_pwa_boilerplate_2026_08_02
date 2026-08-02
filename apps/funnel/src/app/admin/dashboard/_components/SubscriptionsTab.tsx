// Server Component that fetches the initial 30d subscriptions snapshot
// (cohort + rolling + recurring OTO) in parallel and hands it to
// <SubscriptionsClient/>. The client wrapper owns the date-range state and
// re-fetches via the refetch-subscriptions action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import {
  paidConversionsCohort,
  paidConversionsRolling,
  recurringOtoSnapshot,
  subscriptionStatusBreakdown,
  subscriptionVariantBreakdown,
} from '../../_queries/subscriptions';
import { SubscriptionsClient } from './SubscriptionsClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function SubscriptionsTab() {
  const range = default30dRange();
  const [cohort, rolling, recurringOto, statusBreakdown, variantBreakdown] = await Promise.all([
    paidConversionsCohort(range),
    paidConversionsRolling(range),
    recurringOtoSnapshot(range),
    subscriptionStatusBreakdown(range),
    subscriptionVariantBreakdown(range),
  ]);
  return (
    <SubscriptionsClient
      initialData={{ cohort, rolling, recurringOto, statusBreakdown, variantBreakdown }}
    />
  );
}
