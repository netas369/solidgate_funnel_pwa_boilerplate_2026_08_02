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
import {
  Activity,
  BadgeDollarSign,
  CircleDollarSign,
  GitBranch,
  ShoppingBag,
  Users,
  type LucideIcon,
} from 'lucide-react';

type TabKey =
  | 'sessions'
  | 'funnel'
  | 'revenue'
  | 'subscriptions'
  | 'customers'
  | 'otos';

const TABS: Array<{ key: TabKey; label: string; icon: LucideIcon }> = [
  { key: 'sessions', label: 'Sessions', icon: Activity },
  { key: 'funnel', label: 'Funnel', icon: GitBranch },
  { key: 'revenue', label: 'Revenue', icon: CircleDollarSign },
  { key: 'subscriptions', label: 'Subscriptions', icon: BadgeDollarSign },
  { key: 'customers', label: 'Customers', icon: Users },
  { key: 'otos', label: 'Offers', icon: ShoppingBag },
];

export interface TabShellProps {
  sessions: ReactNode | null;
  funnel: ReactNode | null;
  revenue: ReactNode | null;
  subscriptions: ReactNode | null;
  customers: ReactNode | null;
  otos: ReactNode | null;
}

export function TabShell({
  sessions,
  funnel,
  revenue,
  subscriptions,
  customers,
  otos,
}: TabShellProps) {
  const slots: Record<TabKey, ReactNode> = {
    sessions,
    funnel,
    revenue,
    subscriptions,
    customers,
    otos,
  };
  const enabledTabs = TABS.filter((tab) => slots[tab.key] !== null);
  const [active, setActive] = useState<TabKey>(enabledTabs[0]?.key ?? 'sessions');
  if (enabledTabs.length === 0) {
    return <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">No analytics modules are enabled.</p>;
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div
        role="tablist"
        aria-label="Dashboard sections"
        className="flex gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50/80 px-3 pt-2"
      >
        {enabledTabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`admin-tab-${t.key}`}
              aria-controls={`admin-panel-${t.key}`}
              aria-selected={active === t.key}
              onClick={() => setActive(t.key)}
              className={
                active === t.key
                  ? 'inline-flex shrink-0 items-center gap-2 border-b-2 border-sky-600 px-3 py-2.5 text-sm font-semibold text-sky-700'
                  : 'inline-flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-neutral-500 transition-colors hover:text-neutral-900'
              }
            >
              <Icon size={15} aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`admin-panel-${active}`}
        aria-labelledby={`admin-tab-${active}`}
        className="p-4 sm:p-6"
      >
        {slots[active]}
      </div>
    </section>
  );
}
