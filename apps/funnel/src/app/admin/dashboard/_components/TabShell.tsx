'use client';

// D-10: thin client wrapper owning active-tab state.
// All 4 tab Server Components stream their data on page load (passed as
// children) so tab switching is instant. If first-paint cost grows too
// high, Plan 06 can split into per-tab lazy loading via React.lazy.
//
// Plain state-driven UI (buttons + conditional render) — deliberately
// minimal, no @base-ui/react primitive to avoid hydration mismatches
// while shape settles. Plan 06 can swap to a richer primitive if needed.

import { useState, type ReactNode } from 'react';

type TabKey =
  | 'sessions'
  | 'funnel'
  | 'revenue'
  | 'subscriptions'
  | 'customers'
  | 'otos';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'customers', label: 'Customers' },
  { key: 'otos', label: 'OTOs' },
];

export interface TabShellProps {
  sessions: ReactNode;
  funnel: ReactNode;
  revenue: ReactNode;
  subscriptions: ReactNode;
  customers: ReactNode;
  otos: ReactNode;
}

export function TabShell({
  sessions,
  funnel,
  revenue,
  subscriptions,
  customers,
  otos,
}: TabShellProps) {
  const [active, setActive] = useState<TabKey>('sessions');
  const slots: Record<TabKey, ReactNode> = {
    sessions,
    funnel,
    revenue,
    subscriptions,
    customers,
    otos,
  };
  return (
    <section>
      <div
        role="tablist"
        className="mb-4 flex gap-2 border-b border-neutral-200"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
            className={
              active === t.key
                ? 'border-b-2 border-sky-600 px-3 py-2 text-sm font-medium text-sky-700'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900'
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{slots[active]}</div>
    </section>
  );
}
