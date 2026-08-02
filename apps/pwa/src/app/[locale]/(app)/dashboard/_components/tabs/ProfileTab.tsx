"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@repo/i18n/navigation";
import { useDashboard } from "../context";
import { TabHeader } from "./placeholder";
import { LocaleCountrySwitchers } from "../shell/LocaleCountrySwitchers";
import { resetPwaAnalytics } from "@/lib/analytics/posthog";

/**
 * PLACEHOLDER TAB — the account surface.
 *
 * Unlike Home and Library this one is close to shippable: the four rows below
 * (identity, plan, locale, sign-out) are what every member area needs. Extend
 * it rather than replacing it.
 */
export function ProfileTab({ accountEmail }: { accountEmail: string }) {
  const t = useTranslations("pwa.tabs.profile");
  const { hasPremium, openPaywall } = useDashboard();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      // Reset analytics identity only after the server really ended the
      // session; otherwise a failed logout leaves the next user un-identified.
      if (response.ok) resetPwaAnalytics();
    } catch (err) {
      console.error("[profile] logout failed", err);
    }
    router.replace("/login");
  };

  return (
    <div className="pageEnter" style={{ padding: "var(--space-5) var(--space-4) var(--space-6)" }}>
      <TabHeader kicker={t("kicker")} title={t("title")} body={t("body")} />

      <div style={{ marginTop: "var(--space-5)" }}>
        <Row label={t("emailLabel")}>
          <span style={{ color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {accountEmail || "—"}
          </span>
        </Row>

        <Row label={t("planLabel")}>
          <span style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <span style={{ color: "var(--ink)" }}>
              {hasPremium ? t("planPremium") : t("planFree")}
            </span>
            {!hasPremium && (
              <button
                type="button"
                onClick={openPaywall}
                className="tap mono-up"
                style={{
                  background: "transparent",
                  color: "var(--ink)",
                  border: "1px solid var(--ink)",
                  borderRadius: "var(--radius-sm)",
                  padding: "7px 11px",
                  fontSize: 9,
                  cursor: "pointer",
                }}
              >
                {t("upgradeCta")}
              </button>
            )}
          </span>
        </Row>

        <LocaleCountrySwitchers />

        <div style={{ paddingTop: "var(--space-5)" }}>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="tap mono-up"
            style={{
              background: "transparent",
              color: "var(--ink)",
              border: "1px solid var(--ink)",
              borderRadius: "var(--radius-sm)",
              padding: "11px 16px",
              fontSize: 9,
              cursor: signingOut ? "wait" : "pointer",
              opacity: signingOut ? 0.5 : 1,
            }}
          >
            {t("signOut")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 0", borderBottom: "1px solid var(--hairline)" }}>
      <div className="mono-up" style={{ opacity: 0.55, fontSize: 9, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: "var(--text-sm)", minWidth: 0 }}>{children}</div>
    </div>
  );
}
