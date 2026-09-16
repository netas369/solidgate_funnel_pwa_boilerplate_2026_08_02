import { subscriptionsSummaryInRange } from '../../_queries/subscriptions';
import { SubscriptionsClient } from './SubscriptionsClient';
export async function SubscriptionsTab() {
  const now = new Date();
  const start = new Date(now.toISOString().slice(0, 10));
  start.setUTCDate(start.getUTCDate() - 30);
  return <SubscriptionsClient initialData={await subscriptionsSummaryInRange({ from: start.toISOString(), to: now.toISOString() })} />;
}
