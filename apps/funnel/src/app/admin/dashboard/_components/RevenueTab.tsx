import { revenueSummaryInRange } from '../../_queries/revenue';
import { RevenueClient } from './RevenueClient';

export async function RevenueTab() {
  const now = new Date();
  const start = new Date(now.toISOString().slice(0, 10));
  start.setUTCDate(start.getUTCDate() - 30);
  const initialData = await revenueSummaryInRange({ from: start.toISOString(), to: now.toISOString() });
  return <RevenueClient initialData={initialData} />;
}
