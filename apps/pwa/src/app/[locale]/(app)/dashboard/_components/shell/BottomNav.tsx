"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { IconHome, IconLibrary, IconProfile } from "../icons/nav";
import type { TabId } from "../context";

const TABS: { id: TabId; icon: React.ComponentType<{ size?: number; filled?: boolean }> }[] = [
  { id: "home", icon: IconHome },
  { id: "library", icon: IconLibrary },
  { id: "profile", icon: IconProfile },
];

export function BottomNav({ active, onChange }: { active: TabId; onChange: (id: TabId) => void }) {
  const t = useTranslations("pwa.nav");
  return (
    <div style={{
      position: "relative", flexShrink: 0,
      borderTop: "1px solid var(--chrome-line)",
      background: "var(--paper)",
      padding: "14px 0 calc(14px + env(safe-area-inset-bottom))",
      color: "var(--ink)",
    }}>
      {/* Inner row is capped + centered so the tabs stay a tight cluster on wide
          viewports instead of scattering across the full-bleed chrome bar. */}
      <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", position: "relative", maxWidth: 600, margin: "0 auto" }}>
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button key={tab.id} className="tap" onClick={() => onChange(tab.id)}
              style={{
                flex: 1, background: "none", border: "none", padding: "6px 0",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                color: "var(--ink)", cursor: "pointer", position: "relative",
              }}>
              {isActive && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute", top: -15, left: "50%",
                    width: 4, height: 4, background: "var(--accent)", borderRadius: "50%",
                    transform: "translateX(-50%) rotate(45deg)",
                  }}
                />
              )}
              <Icon size={26} filled={isActive} />
              <span className="mono-up" style={{ fontSize: 8, opacity: isActive ? 1 : 0.45, transition: "opacity .2s" }}>
                {t(tab.id)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
