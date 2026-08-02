"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/BrandMark";

export function HamburgerIcon({ open = false, size = 24 }: { open?: boolean; size?: number }) {
  const ease = "cubic-bezier(.7,.02,.2,1)";
  const base: React.CSSProperties = {
    transition: `transform .45s ${ease}, opacity .25s ease`,
    transformBox: "fill-box",
    transformOrigin: "center",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ overflow: "visible" }}>
      <line x1="6" y1="7.5" x2="18" y2="7.5" style={{ ...base, transform: open ? "translateY(4.5px) rotate(45deg)" : "none" }} />
      <line x1="3" y1="12" x2="21" y2="12" style={{ ...base, transform: open ? "scaleX(0)" : "none", opacity: open ? 0 : 1 }} />
      <line x1="6" y1="16.5" x2="18" y2="16.5" style={{ ...base, transform: open ? "translateY(-4.5px) rotate(-45deg)" : "none" }} />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"
        style={{
          transition: `opacity .25s ease ${open ? ".25s" : "0s"}, transform .35s ${ease} ${open ? ".2s" : "0s"}`,
          transformBox: "fill-box", transformOrigin: "center",
          opacity: open ? 1 : 0,
          transform: open ? "scale(1)" : "scale(0.4)",
        }}
      />
    </svg>
  );
}

/**
 * Fixed top chrome: brand on the leading edge, menu trigger on the trailing
 * edge, and an empty centre slot for whatever the product needs there (a
 * context switcher, a streak counter, nothing).
 */
export function TopNav({
  onOpenMenu,
  menuButtonRef,
  menuOpen,
  centerSlot,
}: {
  onOpenMenu: () => void;
  menuButtonRef?: React.Ref<HTMLButtonElement>;
  menuOpen: boolean;
  centerSlot?: React.ReactNode;
}) {
  const t = useTranslations("pwa.topnav");
  return (
    <div style={{
      position: "relative", flexShrink: 0,
      borderBottom: "1px solid var(--chrome-line)",
      background: "var(--paper)",
      padding: "calc(14px + env(safe-area-inset-top)) 18px 12px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      color: "var(--ink)",
      gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
        <BrandMark size={20} />
        <span className="display tn-wordmark" style={{ fontSize: "var(--text-lg)", fontWeight: 600, lineHeight: 1 }}>
          {t("brand")}
        </span>
      </div>

      {centerSlot && (
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          {centerSlot}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
        <button ref={menuButtonRef} onClick={onOpenMenu} className="tap"
          aria-label={menuOpen ? t("closeMenu") : t("openMenu")}
          style={{ background: "none", border: "none", padding: 6, margin: -6, cursor: "pointer", color: "var(--ink)", display: "flex" }}>
          <HamburgerIcon open={menuOpen} />
        </button>
      </div>
    </div>
  );
}
