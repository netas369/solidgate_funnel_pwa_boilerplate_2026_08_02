"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@repo/i18n/navigation";
import { BrandMark } from "@/components/BrandMark";
// The login route reuses the member-area theme tokens so the two screens are
// visually one app. It is the only file outside (app)/ that imports them.
import "../../(app)/dashboard/_components/theme.css";

// Passwordless dev shortcut. The real 6-digit OTP flow is the DEFAULT everywhere
// (including `next dev`); the shortcut only turns on when a developer explicitly
// opts in with NEXT_PUBLIC_ENABLE_DEV_LOGIN=true AND the build is non-production.
// Both env reads are inlined at build time, so in any production build this
// resolves to `false` and the dev branch below is stripped from the bundle.
const DEV_LOGIN_ENABLED =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === "true";
// Prefilled so one click lands on the seeded local account; change to any email.
const DEV_DEFAULT_EMAIL = process.env.NEXT_PUBLIC_DEV_LOGIN_EMAIL ?? "";

function OtpDigits({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? "");

  const focusIndex = (i: number) => {
    refs.current[i]?.focus();
    refs.current[i]?.select();
  };

  const setDigit = (i: number, d: string) => {
    const next = [...digits];
    next[i] = d;
    onChange(next.join(""));
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <input
          key={i}
          ref={(node) => {
            refs.current[i] = node;
          }}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={digits[i]}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, "").slice(-1);
            setDigit(i, next);
            if (next && i < 5) focusIndex(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Backspace") return;
            if (digits[i]) {
              setDigit(i, "");
              return;
            }
            if (i > 0) focusIndex(i - 1);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (!pasted) return;
            e.preventDefault();
            const next = Array.from({ length: 6 }, (_, j) => pasted[j] ?? "");
            onChange(next.join(""));
            focusIndex(Math.min(pasted.length - 1, 5));
          }}
          style={{
            width: 44,
            height: 56,
            border: "1px solid var(--hairline-strong)",
            borderRadius: "var(--radius-sm)",
            background: "var(--paper)",
            color: "var(--ink)",
            textAlign: "center",
            fontSize: 24,
            fontWeight: 500,
            outline: "none",
            padding: 0,
          }}
        />
      ))}
    </div>
  );
}

export function LoginShell() {
  const t = useTranslations("pwa.login");
  const tBrand = useTranslations("pwa.topnav");
  const router = useRouter();

  const [step, setStep] = React.useState<"email" | "otp">("email");
  const [email, setEmail] = React.useState(DEV_LOGIN_ENABLED ? DEV_DEFAULT_EMAIL : "");
  const [code, setCode] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [error, setError] = React.useState("");
  const [cooldown, setCooldown] = React.useState(0);

  const secondsFromError = (message: string | undefined) => {
    const seconds = message?.match(/(\d+)/)?.[1];
    return seconds ? parseInt(seconds, 10) : null;
  };

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setInterval(() => {
      setCooldown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldown]);

  // DEV-ONLY: skip the OTP step entirely. Posts the email to /api/auth/dev-login,
  // which mints a real Supabase session, then lands on the dashboard.
  const devLogin = async () => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as { redirectTo?: string; error?: string };
      if (!res.ok) {
        setError(body.error || t("sendFailed"));
        return;
      }
      router.replace(body.redirectTo || "/dashboard");
    } catch {
      setError(t("sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const requestOtp = async () => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        if (res.status === 429) {
          const seconds = secondsFromError(body.error) ?? 30;
          setCooldown(seconds);
          setError(t("tooManyRequests", { seconds }));
        } else if (res.status === 400) {
          setError(t("invalidEmail"));
        } else {
          setError(t("sendFailed"));
        }
        return;
      }
      setStep("otp");
      setCooldown(30);
    } catch {
      setError(t("sendFailed"));
    } finally {
      setSending(false);
    }
  };

  const verifyCode = async () => {
    if (verifying || code.length !== 6) return;
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, token: code }),
      });
      const body = (await res.json()) as { redirectTo?: string; error?: string };
      if (!res.ok) {
        if (res.status === 429) {
          const minutes = secondsFromError(body.error) ?? 1;
          setError(t("tooManyAttempts", { minutes }));
        } else if (res.status === 400) {
          setError(code.length === 6 ? t("invalidOrExpiredCode") : t("invalidCode"));
        } else {
          setError(t("verifyFailed"));
        }
        return;
      }
      router.replace("/dashboard");
    } catch {
      setError(t("verifyFailed"));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="appRoot" data-surface="dark">
      <div className="app-screen" data-surface="dark">
        {/* ── Top bar (brand only) ─────────────────────────────────────── */}
        <div
          style={{
            position: "relative",
            flexShrink: 0,
            borderBottom: "1px solid var(--chrome-line)",
            background: "var(--paper)",
            padding: "calc(14px + env(safe-area-inset-top)) 18px 12px",
            display: "flex",
            alignItems: "center",
            color: "var(--ink)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BrandMark size={20} />
            <span
              className="display"
              style={{
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: "0.005em",
                lineHeight: 1,
              }}
            >
              {tBrand("brand")}
            </span>
          </div>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "40px 22px 48px",
            background: "var(--paper)",
          }}
        >
          <div style={{ width: "100%", maxWidth: 360 }}>
            {/* Card */}
            <div
              style={{
                background: "var(--paper-soft)",
                border: "1px solid var(--hairline)",
                borderRadius: "var(--radius-lg)",
                padding: "32px 26px 30px",
              }}
            >
              <div className="mono-up" style={{ opacity: 0.5, fontSize: 9, textAlign: "center", marginBottom: 14 }}>
                {t("kicker")}
              </div>

              <h1
                className="display"
                style={{
                  fontSize: 28,
                  lineHeight: 1.12,
                  margin: 0,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  textAlign: "center",
                  color: "var(--ink)",
                }}
              >
                {step === "email" ? t("titleEmail") : t("titleOtp")}
              </h1>

              <p
                className="body-sans"
                style={{
                  margin: "12px auto 0",
                  opacity: 0.65,
                  textAlign: "center",
                  maxWidth: 290,
                  lineHeight: 1.55,
                }}
              >
                {step === "email" ? t("emailHelper") : t("otpHelper", { email })}
              </p>

              <hr className="rule" style={{ margin: "22px auto 24px", width: 64 }} />

              {step === "email" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (DEV_LOGIN_ENABLED) {
                      void devLogin();
                      return;
                    }
                    void requestOtp();
                  }}
                >
                  <label
                    className="mono-up"
                    htmlFor="login-email"
                    style={{ display: "block", opacity: 0.5, fontSize: 9, marginBottom: 8, letterSpacing: "0.2em" }}
                  >
                    {t("emailLabel")}
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={sending}
                    placeholder={t("emailPlaceholder")}
                    style={{
                      width: "100%",
                      border: "1px solid var(--hairline-strong)",
                      borderRadius: 10,
                      background: "var(--paper)",
                      color: "var(--ink)",
                      fontSize: 15,
                      padding: "13px 14px",
                      outline: "none",
                    }}
                  />

                  <button
                    type="submit"
                    disabled={sending || cooldown > 0 || !email}
                    className="tap mono-up"
                    style={{
                      marginTop: 20,
                      width: "100%",
                      background: "var(--accent)",
                      color: "var(--accent-ink)",
                      border: "none",
                      borderRadius: 10,
                      padding: "15px 18px",
                      cursor: sending ? "wait" : "pointer",
                      opacity: sending || cooldown > 0 || !email ? 0.45 : 1,
                      fontSize: 10,
                      letterSpacing: "0.22em",
                      fontWeight: 600,
                    }}
                  >
                    {sending
                      ? t("sending")
                      : DEV_LOGIN_ENABLED
                        ? "Enter (dev — no code)"
                        : cooldown > 0
                          ? t("waitSeconds", { seconds: cooldown })
                          : t("sendCode")}
                  </button>

                  {DEV_LOGIN_ENABLED && (
                    <p
                      style={{
                        marginTop: 12,
                        textAlign: "center",
                        fontSize: 12,
                        opacity: 0.55,
                      }}
                    >
                      Dev mode: any email signs you in instantly, no code. This
                      is disabled in production.
                    </p>
                  )}
                </form>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void verifyCode();
                  }}
                >
                  <div className="mono-up" style={{ opacity: 0.5, fontSize: 9, marginBottom: 12, textAlign: "center" }}>
                    {t("codeLabel")}
                  </div>
                  <OtpDigits value={code} onChange={setCode} disabled={verifying} />

                  <button
                    type="submit"
                    disabled={verifying || code.length !== 6}
                    className="tap mono-up"
                    style={{
                      marginTop: 24,
                      width: "100%",
                      background: "var(--accent)",
                      color: "var(--accent-ink)",
                      border: "none",
                      borderRadius: 10,
                      padding: "15px 18px",
                      cursor: verifying ? "wait" : "pointer",
                      opacity: verifying || code.length !== 6 ? 0.45 : 1,
                      fontSize: 10,
                      letterSpacing: "0.22em",
                      fontWeight: 600,
                    }}
                  >
                    {verifying ? t("verifying") : t("verifyCode")}
                  </button>

                  <button
                    type="button"
                    onClick={() => void requestOtp()}
                    disabled={cooldown > 0 || sending}
                    className="tap mono-up"
                    style={{
                      marginTop: 12,
                      width: "100%",
                      background: "transparent",
                      color: "var(--ink)",
                      border: "1px solid var(--hairline-strong)",
                      borderRadius: 10,
                      padding: "12px 18px",
                      cursor: cooldown > 0 ? "not-allowed" : "pointer",
                      opacity: cooldown > 0 || sending ? 0.45 : 1,
                      fontSize: 9,
                      letterSpacing: "0.22em",
                      fontWeight: 600,
                    }}
                  >
                    {cooldown > 0 ? t("resendIn", { seconds: cooldown }) : t("resend")}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setStep("email");
                      setCode("");
                      setError("");
                    }}
                    style={{
                      marginTop: 16,
                      width: "100%",
                      background: "transparent",
                      color: "var(--ink)",
                      border: "none",
                      padding: 8,
                      fontSize: 13,
                      opacity: 0.55,
                      cursor: "pointer",
                    }}
                  >
                    {t("changeEmail")}
                  </button>
                </form>
              )}

              {error && (
                <p role="alert" style={{ marginTop: 14, color: "var(--danger)", fontSize: 13, textAlign: "center" }}>
                  {error}
                </p>
              )}
            </div>

            <div style={{ marginTop: 22, textAlign: "center" }}>
              <span style={{ fontSize: "var(--text-xs)", opacity: 0.45 }}>
                {t("footnote")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
