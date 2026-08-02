// D-10 + D-15 + D-17: admin dashboard root.
// - Server Component (no client directive): KPI row + 4 tabs are server-rendered
//   in parallel, each wrapped in its own Suspense boundary so slow queries
//   don't block the page shell.
// - dynamic='force-dynamic' + revalidate=0 per D-17: live SQL every visit;
//   the layout.tsx already sets force-dynamic — we repeat it here as
//   defense-in-depth so a future segment-level cache directive can't sneak
//   in without breaking this contract.
//
// TabShell passes the four tab Server Components as children so all four
// stream their data on initial load; switching tabs is instant.

import { Suspense } from 'react';
import { KpiCardsRow } from './_components/KpiCardsRow';
import { KpiCardsSkeleton } from './_components/Skeletons';
import { TabShell } from './_components/TabShell';
import { SessionsTab } from './_components/SessionsTab';
import { FunnelTab } from './_components/FunnelTab';
import { RevenueTab } from './_components/RevenueTab';
import { SubscriptionsTab } from './_components/SubscriptionsTab';
import { CustomersTab } from './_components/CustomersTab';
import { OtosTab } from './_components/OtosTab';

// D-17: live SQL on every visit; no caching.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function AdminDashboardPage() {
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Admin dashboard
        </h1>
        <span className="text-xs text-neutral-500">
          Live SQL. All dates UTC. Updated on page load.
        </span>
      </header>

      {/* D-10 + D-12: KPI row stays Server Component, always 3 buckets side-by-side. */}
      <Suspense fallback={<KpiCardsSkeleton />}>
        <KpiCardsRow />
      </Suspense>

      {/* D-10: tabs below KPI row. TabShell is a thin client wrapper owning
          active-tab state. Each tab is a Server Component subtree streamed
          via Suspense from the tab's own internal sections. */}
      <TabShell
        sessions={<SessionsTab />}
        funnel={<FunnelTab />}
        revenue={<RevenueTab />}
        subscriptions={<SubscriptionsTab />}
        customers={<CustomersTab />}
        otos={<OtosTab />}
      />
    </main>
  );
}
