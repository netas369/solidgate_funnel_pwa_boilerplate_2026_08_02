// Server Component that fetches the initial 30d recent-orders snapshot and
// hands it to <CustomersClient/>. The client wrapper owns the date-range
// state and re-fetches via the refetch-customers action.

import { subDays, startOfDay, formatISO } from 'date-fns';
import { recentOrders } from '../../_queries/customers';
import { CustomersClient } from './CustomersClient';

function default30dRange() {
  const now = new Date();
  return {
    from: formatISO(subDays(startOfDay(now), 30)),
    to: formatISO(now),
  };
}

export async function CustomersTab() {
  const orders = await recentOrders(default30dRange());
  return <CustomersClient initialData={{ orders }} />;
}
