"use client";
import { useTranslations } from "next-intl";
import { PlaceholderSection, TabHeader } from "./placeholder";

/**
 * PLACEHOLDER TAB — replace wholesale with the product's home surface.
 *
 * It exists so the shell has something to render and so the nav, the scroll
 * container and the desktop measure can be seen working. There is no product
 * logic here on purpose.
 */
export function HomeTab({ accountEmail }: { accountEmail: string }) {
  const t = useTranslations("pwa.tabs.home");

  return (
    <div className="pageEnter" style={{ padding: "var(--space-5) var(--space-4) var(--space-6)" }}>
      <TabHeader kicker={t("kicker")} title={t("title")} body={t("body")} />

      <div style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-5)" }}>
        <PlaceholderSection label={t("blockOne")} />
        <PlaceholderSection label={t("blockTwo")} />
      </div>

      <p style={{ marginTop: "var(--space-5)", fontSize: "var(--text-xs)", color: "var(--ink-soft)" }}>
        {t("signedInAs", { email: accountEmail || "—" })}
      </p>
    </div>
  );
}
