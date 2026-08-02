"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@repo/i18n/navigation";
import { IconHome, IconLibrary, IconProfile } from "../icons/nav";
import { HamburgerIcon } from "./TopNav";
import { BrandMark } from "@/components/BrandMark";
import { LocaleCountrySwitchers } from "./LocaleCountrySwitchers";
import type { TabId } from "../context";
import { resetPwaAnalytics } from "@/lib/analytics/posthog";

const NAV_ITEMS: { id: TabId; icon: React.ComponentType<{ size?: number; filled?: boolean }> }[] = [
  { id: "home", icon: IconHome },
  { id: "library", icon: IconLibrary },
  { id: "profile", icon: IconProfile },
];

export function MenuDrawer({
  open, onClose, onOpenOnboarding, active, onChange, accountEmail,
}: {
  open: boolean;
  onClose: () => void;
  onOpenOnboarding: () => void;
  active: TabId;
  onChange: (id: TabId) => void;
  accountEmail: string;
}) {
  const t = useTranslations("pwa.menu");
  const tOnboarding = useTranslations("pwa.onboarding");
  const tTopnav = useTranslations("pwa.topnav");
  const tItems = useTranslations("pwa.menu.items");
  const isRtl = useLocale() === "he";
  // Canonical tab names live in pwa.nav (shared with the bottom nav + screen
  // titles); the drawer reads them so a destination is never named two ways.
  const tNav = useTranslations("pwa.nav");
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const handleNav = (id: TabId) => {
    onChange(id);
    onClose();
  };
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) resetPwaAnalytics();
    } catch (err) {
      console.error("[menu] logout failed", err);
    }
    router.replace("/login");
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "absolute", inset: 0, zIndex: "var(--z-scrim)",
          background: "var(--scrim)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity .3s ease",
        }}
      />
      <div
        aria-hidden={!open}
        inert={open ? undefined : true}
        style={{
          position: "absolute", top: 0, insetInlineEnd: 0, bottom: 0, zIndex: "var(--z-drawer)",
          width: "86%", maxWidth: 360,
          background: "var(--paper)",
          borderInlineStart: "1px solid var(--ink)",
          color: "var(--ink)",
          transform: open ? "translateX(0)" : `translateX(${isRtl ? "-102%" : "102%"})`,
          transition: "transform .4s cubic-bezier(.5,.05,.2,1)",
          display: "flex", flexDirection: "column",
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "14px 22px 12px", borderBottom: "1px solid var(--ink)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BrandMark size={20} />
            <span className="display" style={{ fontSize: "var(--text-xl)", fontWeight: 600, lineHeight: 1 }}>{tTopnav("brand")}</span>
          </div>
          <button onClick={onClose} className="tap" aria-label={tTopnav("closeMenu")}
            style={{ background: "none", border: "none", padding: 6, margin: -6, cursor: "pointer", color: "var(--ink)", display: "flex" }}>
            <HamburgerIcon open={true} />
          </button>
        </div>

        <div style={{ padding: "24px 22px 8px" }}>
          <div className="mono-up" style={{ display: "flex", alignItems: "center", gap: 10, opacity: 0.55 }}>
            <span>{t("navigateLabel")}</span>
            <div style={{ flex: 1, height: 1, background: "var(--ink)", opacity: 0.85 }} />
          </div>
        </div>

        <nav style={{ padding: "6px 0 4px" }}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === active;
            return (
              <button
                key={item.id}
                onClick={() => handleNav(item.id)}
                className="tap"
                style={{
                  width: "100%", background: "none", border: "none",
                  padding: "14px 22px",
                  display: "flex", alignItems: "center", gap: 16,
                  cursor: "pointer", color: "var(--ink)",
                  borderTop: "1px solid var(--hairline)",
                  textAlign: "start",
                  position: "relative",
                }}
              >
                {isActive && (
                  <div style={{
                    position: "absolute", insetInlineStart: 0, top: "50%",
                    width: 5, height: 5, background: "var(--accent)",
                    transform: `translate(${isRtl ? "50%" : "-50%"}, -50%) rotate(45deg)`,
                  }} />
                )}
                <div style={{ width: 26, display: "flex", justifyContent: "center", opacity: isActive ? 1 : 0.85 }}>
                  <Icon size={24} filled={isActive} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="display" style={{ fontSize: "var(--text-lg)", lineHeight: 1.15 }}>
                    {tNav(item.id)}
                  </div>
                  <div style={{ fontSize: "var(--text-sm)", opacity: 0.55, marginTop: 1 }}>
                    {tItems(`${item.id}.sub`)}
                  </div>
                </div>
                <div style={{ opacity: isActive ? 0.9 : 0.3, fontSize: 16 }}>{isRtl ? "←" : "→"}</div>
              </button>
            );
          })}
          <div style={{ borderTop: "1px solid var(--hairline)" }} />
        </nav>

        <div style={{ padding: "32px 22px 8px" }}>
          <div className="mono-up" style={{ display: "flex", alignItems: "center", gap: 10, opacity: 0.55 }}>
            <span>{t("settingsLabel")}</span>
            <div style={{ flex: 1, height: 1, background: "var(--ink)", opacity: 0.85 }} />
          </div>
        </div>

        <div style={{ padding: "4px 22px 0" }}>
          <div style={{ padding: "16px 0", borderBottom: "1px solid var(--hairline)" }}>
            <div className="mono-up" style={{ opacity: 0.55, fontSize: 9, marginBottom: 6 }}>{t("accountLabel")}</div>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {accountEmail}
                </div>
                <div style={{ fontSize: "var(--text-xs)", opacity: 0.55, marginTop: 2 }}>{t("signedIn")}</div>
              </div>
              <button
                onClick={handleSignOut}
                disabled={signingOut}
                className="tap mono-up"
                style={{
                  background: "transparent",
                  color: "var(--ink)",
                  border: "1px solid var(--ink)",
                  padding: "7px 11px",
                  fontSize: 9,
                  letterSpacing: "0.18em",
                  cursor: signingOut ? "wait" : "pointer",
                  opacity: signingOut ? 0.5 : 1,
                  flexShrink: 0,
                }}
              >
                {t("signOut")}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenOnboarding}
            className="tap"
            style={{
              width: "100%",
              minHeight: 58,
              padding: "12px 0",
              border: "none",
              borderBottom: "1px solid var(--hairline)",
              background: "transparent",
              color: "var(--ink)",
              cursor: "pointer",
              display: "grid",
              gridTemplateColumns: "28px minmax(0, 1fr) auto",
              gap: 12,
              alignItems: "center",
              textAlign: "start",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                border: "1px solid var(--hairline-strong)",
                borderRadius: "50%",
                fontSize: 15,
                lineHeight: 1,
              }}
            >
              ?
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="display" style={{ display: "block", fontSize: "var(--text-md)", lineHeight: 1.15 }}>
                {tOnboarding("replay")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: "var(--text-xs)", lineHeight: 1.35, color: "var(--ink-soft)" }}>
                {tOnboarding("replayDescription")}
              </span>
            </span>
            <span aria-hidden="true" style={{ opacity: 0.55, fontSize: 15 }}>
              {isRtl ? "←" : "→"}
            </span>
          </button>

          <LocaleCountrySwitchers />
        </div>

        <div style={{ marginTop: "auto", padding: "28px 22px 28px" }}>
          <hr className="rule" />
          <div style={{ textAlign: "center", marginTop: 16 }}>
            <div style={{ fontSize: "var(--text-sm)", opacity: 0.55 }}>
              {t("tagline")}
            </div>
            <div className="mono-up" style={{ marginTop: 10, opacity: 0.4, fontSize: 8 }}>
              {t("version")}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
