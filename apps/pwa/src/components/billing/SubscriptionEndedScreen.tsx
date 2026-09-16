"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@repo/i18n/navigation";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";
import { resetPwaAnalytics } from "@/lib/analytics/posthog";

/**
 * Full-screen lock shown by the (app) layout when every app-access entitlement
 * (main subscription / lifetime) is revoked, canceled, or expired — the
 * Solidgate hard-cancel case.
 *
 * Styling is self-contained on purpose: it renders OUTSIDE the dashboard tree,
 * so the member-area theme tokens are not in scope here. Keep the literals in
 * sync with the dark surface in dashboard/_components/theme.css.
 */
export function SubscriptionEndedScreen({ canRecoverBilling = false }: { canRecoverBilling?: boolean }) {
  const t = useTranslations("pwa.subscriptionEnded");
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) resetPwaAnalytics();
    } catch (err) {
      console.error("[subscription-ended] logout failed", err);
    }
    router.replace("/login");
  };

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        padding: "48px 28px",
        background: "#131519",
        color: "#eceef1",
        textAlign: "center",
      }}
    >
      <div aria-hidden="true" style={{ width: 44, height: 1, background: "rgba(255,255,255,0.28)" }} />
      <h1
        style={{
          fontSize: 28,
          lineHeight: 1.2,
          fontWeight: 600,
          margin: 0,
          maxWidth: 420,
        }}
      >
        {t("title")}
      </h1>
      <p
        style={{
          fontSize: 15,
          lineHeight: 1.6,
          margin: 0,
          maxWidth: 420,
          opacity: 0.78,
        }}
      >
        {t("body")}
      </p>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 10 }}>
        {canRecoverBilling && <Link href="/billing/update-payment" style={{ color: 'inherit', textDecoration: 'underline' }}>Update payment method</Link>}
        <a
          href={`mailto:${BOILERPLATE_BRAND.supportEmail}`}
          style={{
            color: "#131519",
            background: "#eceef1",
            padding: "13px 26px",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "0.02em",
            textDecoration: "none",
          }}
        >
          {t("support")}
        </a>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          style={{
            background: "none",
            border: "none",
            color: "#eceef1",
            opacity: signingOut ? 0.4 : 0.6,
            fontSize: 13,
            textDecoration: "underline",
            textUnderlineOffset: 3,
            cursor: signingOut ? "default" : "pointer",
            padding: 6,
          }}
        >
          {t("signOut")}
        </button>
      </div>
    </main>
  );
}
