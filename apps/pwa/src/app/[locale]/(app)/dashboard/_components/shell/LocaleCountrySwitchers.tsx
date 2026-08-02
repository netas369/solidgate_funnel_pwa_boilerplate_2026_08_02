"use client";
import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@repo/i18n/navigation";
import { routing, type Locale } from "@repo/i18n/routing";

// Endonym for every routing locale. Only `en` messages ship, but the
// switcher must still name each locale in its own language — keep this map in
// step with routing.locales or the label lookup returns undefined.
const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  cs: "Čeština",
  hu: "Magyar",
  sk: "Slovenčina",
  ro: "Română",
  lt: "Lietuvių",
  ru: "Русский",
  lv: "Latviešu",
  "zh-TW": "中文（繁體）",
  el: "Ελληνικά",
  he: "עברית",
  pl: "Polski",
  hr: "Hrvatski",
  da: "Dansk",
  ja: "日本語",
};

export function LocaleCountrySwitchers() {
  const currentLocale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("pwa.settings");

  const [langOpen, setLangOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const persistLocale = React.useCallback(async (next: Locale) => {
    try {
      await fetch("/api/user-prefs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
    } catch {
      // Cookie-side fallback: next-intl router.replace already wrote NEXT_LOCALE.
    }
  }, []);

  const handleLocaleChange = React.useCallback(
    async (next: Locale) => {
      if (next === currentLocale || busy) return;
      setBusy(true);
      setLangOpen(false);
      // Persist BEFORE navigating. Locale-aware server routes read
      // `user_prefs.locale`, and the new dashboard render fires their fetches
      // immediately. Fire-and-forget here causes a race where the API sees the
      // OLD locale and returns stale or empty content.
      await persistLocale(next);
      router.replace(pathname, { locale: next });
    },
    [currentLocale, busy, persistLocale, router, pathname],
  );

  return (
    <>
      {/* ── Language ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px 0", borderBottom: "1px solid var(--hairline)" }}>
        <div
          className="tap"
          onClick={() => setLangOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <div style={{ flex: 1 }}>
            <div className="mono-up" style={{ opacity: 0.55, fontSize: 9, marginBottom: 6 }}>
              {t("language")}
            </div>
            <div style={{ fontSize: 14 }}>{LOCALE_LABELS[currentLocale]}</div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 11,
              color: "var(--ink)",
            }}
          >
            <span className="mono-up" style={{ opacity: 0.5 }}>
              {currentLocale}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              style={{
                transition: "transform .25s ease",
                transform: langOpen ? "rotate(180deg)" : "none",
              }}
            >
              <path d="M2 4 L5 7 L8 4" />
            </svg>
          </div>
        </div>

        {langOpen && (
          <div className="pageEnter" style={{ marginTop: 14, border: "1px solid var(--ink)" }}>
            {(routing.locales as readonly Locale[]).map((code, i) => {
              const isCurrent = code === currentLocale;
              return (
                <button
                  key={code}
                  onClick={() => handleLocaleChange(code)}
                  disabled={busy}
                  className="tap"
                  style={{
                    width: "100%",
                    background: isCurrent ? "var(--accent)" : "var(--paper)",
                    color: isCurrent ? "var(--accent-ink)" : "var(--ink)",
                    border: "none",
                    borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
                    padding: "11px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: busy ? "wait" : "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    fontSize: 14,
                  }}
                >
                  <span>{LOCALE_LABELS[code]}</span>
                  <span
                    className="mono-up"
                    style={{ opacity: isCurrent ? 0.7 : 0.45, fontSize: 9 }}
                  >
                    {code}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

    </>
  );
}
