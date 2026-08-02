"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useDashboard } from "../context";
import { PlaceholderSection, TabHeader } from "./placeholder";
import { ProductPurchaseSheet, type PurchasableItem } from "../shell/ProductPurchaseSheet";

/**
 * PLACEHOLDER TAB — demonstrates the two commerce surfaces a member area needs:
 *
 *  1. the ENTITLEMENT GATE: locked content stays locked until `hasPremium`,
 *     and the unlock button opens the real paywall sheet;
 *  2. the ONE-TIME PURCHASE: a single product bought with the vaulted card via
 *     ProductPurchaseSheet.
 *
 * Replace the placeholder rows with real catalogue items; keep both patterns.
 */
export function LibraryTab({
  locale,
  oneTimeItem,
}: {
  locale: string;
  /** One purchasable one-time product, resolved server-side. */
  oneTimeItem: PurchasableItem;
}) {
  const t = useTranslations("pwa.tabs.library");
  const { hasPremium, openPaywall } = useDashboard();
  const [buying, setBuying] = React.useState(false);

  return (
    <div className="pageEnter" style={{ padding: "var(--space-5) var(--space-4) var(--space-6)" }}>
      <TabHeader kicker={t("kicker")} title={t("title")} body={t("body")} />

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
        <PlaceholderSection label={t("freeItem")} />

        {/* The entitlement gate. hasPremium comes from a server-side
            entitlement read, and the client copy is never the authority: the
            gated content is not sent to an unentitled client at all in a real
            implementation. */}
        {hasPremium ? (
          <PlaceholderSection label={t("premiumItem")} />
        ) : (
          <section className="placeholder-block" style={{ textAlign: "center" }}>
            <div className="mono-up" style={{ opacity: 0.5, marginBottom: "var(--space-3)" }}>
              {t("lockedLabel")}
            </div>
            <p className="body-sans" style={{ margin: "0 0 var(--space-4)" }}>{t("lockedBody")}</p>
            <button
              type="button"
              onClick={openPaywall}
              className="tap"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
                border: "1px solid var(--accent)",
                borderRadius: "var(--radius-md)",
                padding: "12px 20px",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
              }}
            >
              {t("unlockCta")}
            </button>
          </section>
        )}

        {/* The one-time purchase. */}
        <section className="placeholder-block">
          <div className="mono-up" style={{ opacity: 0.5, marginBottom: "var(--space-3)" }}>
            {t("oneTimeLabel")}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--ink)", fontSize: "var(--text-md)" }}>{oneTimeItem.label}</div>
              <div style={{ fontSize: "var(--text-xs)", opacity: 0.65 }}>{oneTimeItem.price}</div>
            </div>
            <button
              type="button"
              onClick={() => setBuying(true)}
              className="tap"
              style={{
                background: "transparent",
                color: "var(--ink)",
                border: "1px solid var(--hairline-strong)",
                borderRadius: "var(--radius-md)",
                padding: "10px 16px",
                fontSize: "var(--text-sm)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {t("buyCta")}
            </button>
          </div>
        </section>
      </div>

      {buying && (
        <ProductPurchaseSheet
          item={oneTimeItem}
          locale={locale}
          onClose={() => setBuying(false)}
        />
      )}
    </div>
  );
}
