"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { DashboardProvider, type TabId } from "./context";
import { TopNav } from "./shell/TopNav";
import { BottomNav } from "./shell/BottomNav";
import { MenuDrawer } from "./shell/MenuDrawer";
import { PaywallSheet } from "./shell/PaywallSheet";
import { TrialPromoGate } from "./shell/TrialPromoGate";
import { FirstRunOnboarding } from "./shell/FirstRunOnboarding";
import type { PurchasableItem } from "./shell/ProductPurchaseSheet";
import { HomeTab } from "./tabs/HomeTab";
import { LibraryTab } from "./tabs/LibraryTab";
import { ProfileTab } from "./tabs/ProfileTab";
import "./theme.css";

/**
 * The member-area shell: fixed top/bottom chrome, one scrolling content pane,
 * and the overlays (menu drawer, paywall, onboarding) that must sit above both.
 *
 * Everything product-specific lives in the tabs. This file should stay boring.
 */
export function DashboardShell({
  accountEmail,
  hasPremium: hasPremiumInitial,
  upsellPrice,
  oneTimeItem,
}: {
  accountEmail: string;
  /** Server-resolved entitlement flag. The client copy is UI state only. */
  hasPremium: boolean;
  /** Locale-formatted price for the upsell sheet (e.g. "€19.00"). */
  upsellPrice?: string;
  /** The one-time product the Library tab offers. */
  oneTimeItem: PurchasableItem;
}) {
  const tScreens = useTranslations("pwa.screens");
  const TITLE_MAP: Record<TabId, string> = {
    home: tScreens("home"),
    library: tScreens("library"),
    profile: tScreens("profile"),
  };
  const [active, setActive] = React.useState<TabId>("home");
  const [paywallOpen, setPaywallOpen] = React.useState(false);
  const [hasPremium, setHasPremium] = React.useState(hasPremiumInitial);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [onboardingMode, setOnboardingMode] = React.useState<"auto" | "replay" | null>("auto");
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const currentLocale = useLocale();
  const closeOnboarding = React.useCallback(() => setOnboardingMode(null), []);
  const replayOnboarding = React.useCallback(() => {
    setMenuOpen(false);
    setOnboardingMode("replay");
  }, []);

  const ctxValue = React.useMemo(
    () => ({
      hasPremium,
      setHasPremium,
      openPaywall: () => setPaywallOpen(true),
      active,
      setActive,
    }),
    [hasPremium, active],
  );

  const onboardingOpen = onboardingMode !== null;

  return (
    <DashboardProvider value={ctxValue}>
      <div className="appRoot" data-surface="dark">
        <div className="app-screen" data-surface="dark" data-screen-label={TITLE_MAP[active]}>
          {/* `inert` on the shell while the onboarding modal is open: the modal
              is a sibling, not a child, so without this the whole dashboard
              stays tabbable behind it. */}
          <div
            inert={onboardingOpen ? true : undefined}
            aria-hidden={onboardingOpen ? true : undefined}
            style={{
              position: "relative",
              display: "flex",
              flex: 1,
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <TopNav
              onOpenMenu={() => setMenuOpen((o) => !o)}
              menuButtonRef={menuButtonRef}
              menuOpen={menuOpen}
            />

            {/* No paddingTop on the scroll container: a top padding lets content
                bleed up through it above a position:sticky child, showing a
                sliver above the pinned bar. Each tab carries its own spacing. */}
            <div className="app-content" key={active}>
              {active === "home" && <HomeTab accountEmail={accountEmail} />}
              {active === "library" && (
                <LibraryTab locale={currentLocale} oneTimeItem={oneTimeItem} />
              )}
              {active === "profile" && <ProfileTab accountEmail={accountEmail} />}
            </div>

            <BottomNav active={active} onChange={setActive} />

            <MenuDrawer
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              onOpenOnboarding={replayOnboarding}
              active={active}
              onChange={setActive}
              accountEmail={accountEmail}
            />

            {paywallOpen && (
              <PaywallSheet
                priceLabel={upsellPrice}
                onClose={() => setPaywallOpen(false)}
                onUnlock={() => {
                  setHasPremium(true);
                  setPaywallOpen(false);
                }}
              />
            )}

            {/* Beacons the app-open and may auto-open the paywall. Suppressed
                while onboarding is up so a first-run member is not hit with an
                upsell over the tour. */}
            {!onboardingOpen && <TrialPromoGate />}
          </div>

          {onboardingMode && (
            <FirstRunOnboarding
              mode={onboardingMode}
              // TODO(new product): wire this to whatever first-visit
              // provisioning the product does (a generated document, an
              // imported plan). `true` skips straight to "ready".
              ready
              returnFocusRef={menuButtonRef}
              onClose={closeOnboarding}
            />
          )}
        </div>
      </div>
    </DashboardProvider>
  );
}
