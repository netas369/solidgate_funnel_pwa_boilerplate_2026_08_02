"use client";

import * as React from "react";
import { Link, usePathname, useRouter } from "@repo/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { routing, type Locale } from "@repo/i18n/routing";
import { BOILERPLATE_BRAND } from "@repo/shared/boilerplate-brand";

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

/**
 * Placeholder wordmark glyph — inline SVG so the boilerplate ships no logo
 * asset. TODO(new product): drop in your own mark.
 */
function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 18 L12 6 L18 18" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M8.6 14 H15.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const t = useTranslations("common.ui");
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const onPick = (next: Locale) => {
    setOpen(false);
    if (next === locale) return;
    router.replace(pathname, { locale: next });
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t("selectLanguage")}
        className="tap mono-up"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          color: "var(--ink)",
          border: "1px solid var(--ink)",
          padding: "7px 11px",
          fontSize: 9,
          letterSpacing: "0.18em",
          cursor: "pointer",
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span>{locale.toUpperCase()}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          style={{ transition: "transform .25s ease", transform: open ? "rotate(180deg)" : "none" }}
        >
          <path d="M2 4 L5 7 L8 4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 60,
            minWidth: 220,
            background: "var(--paper)",
            border: "1px solid var(--ink)",
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {(routing.locales as readonly Locale[]).map((code, i) => {
            const isActive = code === locale;
            return (
              <button
                key={code}
                onClick={() => onPick(code)}
                className="tap"
                style={{
                  width: "100%",
                  background: isActive ? "var(--accent)" : "var(--paper)",
                  color: isActive ? "var(--accent-ink)" : "var(--ink)",
                  border: "none",
                  borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
                  padding: "11px 14px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  fontSize: 14,
                }}
              >
                <span>{LOCALE_LABELS[code]}</span>
                <span className="mono-up" style={{ opacity: isActive ? 0.85 : 0.45, fontSize: 9 }}>
                  {code}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function LandingNav({ minimal = false }: { minimal?: boolean } = {}) {
  const t = useTranslations("common");
  const pwaUrl = process.env.NEXT_PUBLIC_PWA_URL || "http://localhost:3206";

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--paper)",
        borderBottom: "1px solid var(--ink)",
        color: "var(--ink)",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "calc(14px + env(safe-area-inset-top)) 22px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 9, color: "var(--ink)", textDecoration: "none" }}>
          <BrandMark size={20} />
          <span className="serif" style={{ fontSize: 23, fontWeight: 600, lineHeight: 1, letterSpacing: "0.005em" }}>
            {BOILERPLATE_BRAND.name}
          </span>
        </Link>

        {!minimal && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <a
              href={`${pwaUrl}/login`}
              aria-label={t("nav.memberArea")}
              className="tap showOnSmall"
              style={{
                display: "none",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ink)",
                textDecoration: "none",
                border: "1px solid var(--ink)",
                padding: "6px 8px",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
              </svg>
            </a>
            <a
              href={`${pwaUrl}/login`}
              className="mono-up tap hideOnSmall"
              style={{
                color: "var(--ink)",
                textDecoration: "none",
                padding: "7px 11px",
                fontSize: 9,
                letterSpacing: "0.18em",
              }}
            >
              {t("nav.memberArea")}
            </a>
            <LocaleSwitcher />
            <Link
              href="/quiz"
              className="tap mono-up hideOnTiny"
              style={{
                background: "var(--accent)",
                color: "var(--accent-ink)",
                border: "1px solid var(--ink)",
                padding: "9px 14px",
                fontSize: 9,
                letterSpacing: "0.2em",
                textDecoration: "none",
              }}
            >
              {t("nav.startQuiz")}
            </Link>
          </div>
        )}
      </div>
      <style>{`
        @media (max-width: 640px) {
          .hideOnSmall { display: none !important; }
          .showOnSmall { display: inline-flex !important; }
        }
        @media (max-width: 420px) {
          .hideOnTiny { display: none !important; }
        }
      `}</style>
    </header>
  );
}
