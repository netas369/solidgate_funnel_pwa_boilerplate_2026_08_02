import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@repo/i18n/navigation";
import { BOILERPLATE_BRAND, BOILERPLATE_COPY } from "@repo/shared/boilerplate-brand";
import { LandingNav } from "./_components/landing/LandingNav";
import "./_components/landing/landing.css";

/**
 * Placeholder landing page.
 *
 * Deliberately plain: it exists to prove the funnel's chrome works end to end
 * (nav → locale switcher → /quiz) and to give you an obvious file to delete.
 * Every visual is inline SVG or a CSS gradient — the boilerplate ships no
 * raster art beyond the favicons and og-image.png, so a `<Image src="…">` here
 * would 404.
 *
 * Copy lives in packages/i18n/messages/en/common.json under `landing.*`.
 *
 * TODO(new product): replace this whole route with your real landing page.
 */

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("common");

  return (
    <main className="lmRoot" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      <LandingNav />

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--hairline)",
          background:
            "linear-gradient(180deg, var(--paper) 0%, var(--paper-soft) 100%)",
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            padding: "72px 22px",
            display: "grid",
            gap: 44,
            gridTemplateColumns: "minmax(0, 1fr)",
            width: "100%",
          }}
        >
          <div style={{ maxWidth: 640 }}>
            <p className="mono-up" style={{ opacity: 0.6, marginBottom: 18 }}>
              {t("landing.hero.eyebrow")}
            </p>
            <h1
              className="serif"
              style={{
                fontSize: "clamp(34px, 6vw, 60px)",
                lineHeight: 1.06,
                margin: 0,
                color: "var(--ink)",
              }}
            >
              {t("landing.hero.headline")}
            </h1>
            <p
              className="body-sans"
              style={{ marginTop: 20, fontSize: 17, maxWidth: 560 }}
            >
              {t("landing.hero.subheadline")}
            </p>
            <p className="body-sans" style={{ marginTop: 12, maxWidth: 560, opacity: 0.75 }}>
              {t("landing.hero.body")}
            </p>

            <div
              style={{
                marginTop: 30,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 14,
              }}
            >
              <Link
                href="/quiz"
                className="tap mono-up"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                  border: "1px solid var(--ink)",
                  padding: "14px 24px",
                  textDecoration: "none",
                  fontSize: 10,
                  letterSpacing: "0.2em",
                }}
              >
                {t("landing.hero.ctaPrimary")}
              </Link>
              <span className="body-sans" style={{ opacity: 0.6 }}>
                {t("landing.hero.note")}
              </span>
            </div>
          </div>

          {/* Placeholder visual: pure SVG, no asset dependency. */}
          <figure style={{ margin: 0, maxWidth: 560 }}>
            <div
              className="imgPh"
              style={{ aspectRatio: "16 / 10" }}
              role="img"
              aria-label={t("landing.hero.imageCaption")}
            >
              <span className="label mono-up">
                {t("landing.hero.figureLabel")} {t("landing.hero.figureNumber")}
              </span>
            </div>
            <figcaption
              className="mono-up"
              style={{ marginTop: 10, opacity: 0.55 }}
            >
              {t("landing.hero.imageCaption")}
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ── Placeholder value props ──────────────────────────────────── */}
      <section style={{ borderBottom: "1px solid var(--hairline)" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "56px 22px" }}>
          <h2 className="serif" style={{ fontSize: 30, margin: 0, color: "var(--ink)" }}>
            {t("landing.benefits.heading")}
          </h2>
          <div
            style={{
              marginTop: 28,
              display: "grid",
              gap: 22,
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            }}
          >
            {(
              [
                ["personalTitle", "personalDescription"],
                ["timeTitle", "timeDescription"],
                ["supportTitle", "supportDescription"],
              ] as const
            ).map(([titleKey, bodyKey]) => (
              <div
                key={titleKey}
                style={{ border: "1px solid var(--hairline)", padding: 20 }}
              >
                <h3
                  className="serif"
                  style={{ fontSize: 20, margin: 0, color: "var(--ink)" }}
                >
                  {t(`landing.benefits.${titleKey}`)}
                </h3>
                <p className="body-sans" style={{ marginTop: 10 }}>
                  {t(`landing.benefits.${bodyKey}`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing CTA ──────────────────────────────────────────────── */}
      <section
        style={{
          background: "var(--ink)",
          color: "var(--accent-ink)",
          padding: "56px 22px",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
          <p className="mono-up" style={{ opacity: 0.6 }}>
            {t("landing.cta.eyebrow")}
          </p>
          <h2 className="serif" style={{ fontSize: 34, margin: "14px 0 0" }}>
            {t("landing.cta.heading")}
          </h2>
          <p style={{ marginTop: 12, opacity: 0.75 }}>
            {t("landing.cta.subheading")}
          </p>
          <Link
            href="/quiz"
            className="tap mono-up"
            style={{
              display: "inline-block",
              marginTop: 26,
              background: "var(--accent-ink)",
              color: "var(--ink)",
              padding: "14px 26px",
              textDecoration: "none",
              fontSize: 10,
              letterSpacing: "0.2em",
            }}
          >
            {t("landing.cta.button")}
          </Link>
          <p className="mono-up" style={{ marginTop: 16, opacity: 0.5 }}>
            {t("landing.cta.disclaimer")}
          </p>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer
        style={{
          borderTop: "1px solid var(--hairline)",
          padding: "26px 22px calc(26px + env(safe-area-inset-bottom))",
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span className="body-sans" style={{ opacity: 0.7 }}>
            {t("footer.copyrightFull", { year: new Date().getFullYear() })}
          </span>
          <nav
            aria-label="Legal"
            style={{ display: "flex", flexWrap: "wrap", gap: 16 }}
          >
            <Link className="mono-up" href="/privacy" style={{ color: "var(--ink)" }}>
              {t("footer.privacy")}
            </Link>
            <Link className="mono-up" href="/terms" style={{ color: "var(--ink)" }}>
              {t("footer.terms")}
            </Link>
            <Link className="mono-up" href="/subscription" style={{ color: "var(--ink)" }}>
              {t("footer.subscription")}
            </Link>
            <a
              className="mono-up"
              href={`mailto:${BOILERPLATE_BRAND.supportEmail}`}
              style={{ color: "var(--ink)" }}
            >
              {t("footer.contact")}
            </a>
          </nav>
        </div>
        <p
          className="body-sans"
          style={{ maxWidth: 1180, margin: "14px auto 0", opacity: 0.45 }}
        >
          {BOILERPLATE_COPY.homepageBody}
        </p>
      </footer>
    </main>
  );
}
