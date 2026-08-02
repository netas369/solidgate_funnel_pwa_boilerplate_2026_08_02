"use client";
import * as React from "react";

/**
 * Member-area shell context.
 *
 * TODO(new product): add product state here (the loaded document, the current
 * plan, whatever the tabs need). Keep it to state that must survive a TAB
 * SWITCH — anything a single tab owns belongs in that tab.
 */

export type TabId = "home" | "library" | "profile";

type Ctx = {
  /** True iff the account holds an active upsell entitlement (see
   *  PWA_SUBSCRIPTION_PRODUCT). Drives the entitlement gate on locked tabs. */
  hasPremium: boolean;
  setHasPremium: (v: boolean) => void;
  /** Open the upsell sheet. The sheet runs the real Solidgate purchase flow. */
  openPaywall: () => void;
  active: TabId;
  setActive: (id: TabId) => void;
};

const DashboardContext = React.createContext<Ctx | null>(null);

export function DashboardProvider({ value, children }: { value: Ctx; children: React.ReactNode }) {
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): Ctx {
  const v = React.useContext(DashboardContext);
  if (!v) throw new Error("useDashboard must be used inside DashboardProvider");
  return v;
}
