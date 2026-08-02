"use client";
import * as React from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { startPurchase, confirmPurchase, type MerchantData } from "@/lib/solidgate/checkout";
import { SolidgatePaymentForm } from "@/components/solidgate/SolidgatePaymentForm";
import { PWA_SUBSCRIPTION_PRODUCT } from "@/lib/pwa-products";

/**
 * The member-area upsell sheet — the one place a subscription is sold from
 * inside the app.
 *
 * It is deliberately NOT a mock: every button here runs the real Solidgate
 * order machine (open → charge saved card or mount the hosted form → confirm),
 * because a paywall that only flips a boolean is worse than no paywall — it
 * ships looking finished while charging nobody.
 *
 * TODO(new product): the copy comes from the `pwa.upsell` namespace and the
 * product from PWA_SUBSCRIPTION_PRODUCT. Change those, not this file.
 */
export function PaywallSheet({
  onClose,
  onUnlock,
  slug = PWA_SUBSCRIPTION_PRODUCT,
  priceLabel,
}: {
  onClose: () => void;
  onUnlock: () => void;
  /** Product to sell. Defaults to the member-area subscription. */
  slug?: string;
  /** Locale-formatted price, resolved server-side (e.g. "€19.00"). */
  priceLabel?: string;
}) {
  const t = useTranslations("pwa.upsell");
  const tPayment = useTranslations("pwa.payment");
  const locale = useLocale();
  const router = useRouter();
  const features = t.raw("features") as { title: string; sub: string }[];
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmingHosted, setConfirmingHosted] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [pendingOrderId, setPendingOrderId] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  // Set when we hold no usable card and the hosted form must collect one.
  const [sgForm, setSgForm] = React.useState<{ merchantData: MerchantData; orderId: string } | null>(null);

  const rememberPending = React.useCallback((orderId?: string) => {
    setPending(true);
    setPendingOrderId(orderId ?? null);
  }, []);

  const clearPending = React.useCallback(() => {
    setPending(false);
    setPendingOrderId(null);
  }, []);

  const grant = React.useCallback(() => {
    router.refresh();
    onUnlock();
  }, [onUnlock, router]);

  const replaceTerminalOrder = React.useCallback(async (terminalOrderId: string) => {
    const replacement = await startPurchase({
      slug,
      locale,
      forceForm: true,
    });
    if (replacement.kind === "granted" || replacement.kind === "already_owned") {
      grant();
      return;
    }
    if (replacement.kind === "needs_card" && replacement.orderId !== terminalOrderId) {
      clearPending();
      setSgForm({ merchantData: replacement.merchantData, orderId: replacement.orderId });
      return;
    }

    rememberPending(terminalOrderId);
    if (replacement.kind === "failed" || replacement.kind === "redirect") {
      setErrorMsg(t("error"));
    }
  }, [clearPending, grant, locale, rememberPending, slug, t]);

  // One click when the card vaulted at checkout is on the account; otherwise
  // the hosted form collects one and confirm() grants + vaults it. forceForm
  // skips the saved card — the "use a different card" path.
  const subscribe = React.useCallback(async (forceForm: boolean) => {
    if (submitting) return;
    const orderToConfirm = pending ? pendingOrderId : null;
    setSubmitting(true);
    setPending(false);
    setErrorMsg(null);
    try {
      const outcome = orderToConfirm
        ? await confirmPurchase(orderToConfirm)
        : await startPurchase({ slug, locale, forceForm });
      if (outcome.kind === "granted" || outcome.kind === "already_owned") {
        grant();
        return;
      }
      if (outcome.kind === "needs_card") {
        if (orderToConfirm && outcome.orderId === orderToConfirm) {
          rememberPending(orderToConfirm);
          return;
        }
        clearPending();
        setSgForm({ merchantData: outcome.merchantData, orderId: outcome.orderId });
        return;
      }
      if (outcome.kind === "redirect") {
        window.location.assign(outcome.verifyUrl);
        return;
      }
      if (outcome.kind === "pending") {
        rememberPending(outcome.orderId ?? orderToConfirm ?? undefined);
        return;
      }
      if (outcome.httpStatus === 402 && outcome.orderId) {
        await replaceTerminalOrder(outcome.orderId);
        return;
      }
      clearPending();
      setErrorMsg(t("error"));
    } catch (err) {
      console.error("[paywall] subscribe failed:", err);
      if (orderToConfirm) rememberPending(orderToConfirm);
      else setErrorMsg(t("error"));
    } finally {
      setSubmitting(false);
    }
  }, [
    clearPending,
    grant,
    locale,
    pending,
    pendingOrderId,
    rememberPending,
    replaceTerminalOrder,
    slug,
    submitting,
    t,
  ]);

  const handleSubscribe = React.useCallback(() => subscribe(false), [subscribe]);

  const confirmHostedPurchase = React.useCallback(async (orderId: string) => {
    if (confirmingHosted) return;
    setConfirmingHosted(true);
    setPending(false);
    setErrorMsg(null);
    try {
      const outcome = await confirmPurchase(orderId);
      if (outcome.kind === "granted") {
        grant();
        return;
      }
      if (outcome.kind === "pending") {
        // The SDK already submitted this hosted order. Retry confirmation for
        // that ID only; never treat its success callback as an access grant.
        rememberPending(orderId);
        return;
      }
      if (outcome.kind === "failed" && outcome.httpStatus === 402) {
        await replaceTerminalOrder(orderId);
        return;
      }
      rememberPending(orderId);
      setErrorMsg(t("error"));
    } catch (err) {
      console.error("[paywall] hosted confirmation failed:", err);
      rememberPending(orderId);
      setErrorMsg(t("error"));
    } finally {
      setConfirmingHosted(false);
    }
  }, [confirmingHosted, grant, rememberPending, replaceTerminalOrder, t]);

  if (sgForm) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: "var(--z-sheet)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim)" }} />
        <div style={{ position: "relative", width: "100%", background: "var(--paper)", borderTop: "1px solid var(--ink)", padding: 20, maxHeight: "92%", overflowY: "auto" }}>
          <p className="mono-up" style={{ marginBottom: 12, color: "var(--ink-soft)" }}>{priceLabel}</p>
          <SolidgatePaymentForm
            merchantData={sgForm.merchantData}
            orderId={sgForm.orderId}
            buttonText={t("subscribeCta")}
            enableApplePay
            savedMethodDisclosure={tPayment("savedMethodDisclosure")}
            onPaid={(orderId) => void confirmHostedPurchase(orderId)}
            onFail={() => setErrorMsg(t("error"))}
          />
          {(confirmingHosted || pending) && (
            <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
              <p role="status" aria-live="polite" style={{ color: "var(--ink-soft)", margin: 0 }}>
                {t("pendingActivation")}
              </p>
              {pending && (
                <button
                  type="button"
                  onClick={() => void confirmHostedPurchase(sgForm.orderId)}
                  className="tap"
                  style={{ marginTop: 14, padding: "12px 18px" }}
                >
                  {t("subscribeCta")}
                </button>
              )}
            </div>
          )}
          {errorMsg && <p style={{ color: "var(--danger)", textAlign: "center", marginTop: 10 }}>{errorMsg}</p>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: "var(--z-sheet)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim)", animation: "appFadeUp .25s ease" }} />
      <div style={{
        position: "relative", width: "100%", background: "var(--paper)",
        borderTop: "1px solid var(--ink)",
        animation: "appFadeUp .4s cubic-bezier(.4,0,.2,1)",
        maxHeight: "92%", height: "92%",
        color: "var(--ink-soft)",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "14px 0", flexShrink: 0 }}>
          <div style={{ width: 36, height: 3, background: "var(--hairline-strong)", borderRadius: 2, margin: "0 auto" }} />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
          <div style={{ padding: "14px 26px 22px", textAlign: "center" }}>
            <div className="mono-up" style={{ opacity: 0.55, marginBottom: 14 }}>{t("kicker")}</div>
            <h2 className="display" style={{ fontSize: "var(--text-2xl)", lineHeight: 1.1, margin: "0 0 12px", fontWeight: 600, color: "var(--ink)" }}>
              {t("title")}
            </h2>
            <p className="body-sans" style={{ maxWidth: 280, margin: "0 auto", opacity: 0.7 }}>
              {t("subtitle")}
            </p>
          </div>

          <div style={{ padding: "0 26px 24px" }}>
            <div style={{ borderTop: "1px solid var(--ink)" }}>
              {features.map((row, i) => (
                <div key={i} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: "1px solid var(--hairline)" }}>
                  <div style={{ paddingTop: 3, color: "var(--ink)" }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 7 L6 11 L12 3" /></svg>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "var(--text-sm)", marginBottom: 2, color: "var(--ink)" }}>{row.title}</div>
                    <div style={{ fontSize: "var(--text-xs)", opacity: 0.6 }}>{row.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{
          flexShrink: 0,
          borderTop: "1px solid var(--hairline)",
          background: "var(--paper)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}>
          <div style={{ padding: "16px 22px 4px", textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 6 }}>
              {priceLabel && (
                <span className="display" style={{ fontSize: "var(--text-2xl)", lineHeight: 1, color: "var(--ink)" }}>{priceLabel}</span>
              )}
              <span style={{ fontSize: "var(--text-xs)", opacity: 0.6 }}>{t("cadence")}</span>
            </div>
            <div style={{ fontSize: "var(--text-xs)", opacity: 0.6, marginTop: 6 }}>{t("billedNow")}</div>
          </div>

          {errorMsg && (
            <div role="alert" style={{ padding: "0 22px 6px", textAlign: "center", color: "var(--danger)", fontSize: "var(--text-sm)" }}>
              {errorMsg}
            </div>
          )}
          {pending && (
            <div role="status" aria-live="polite" style={{ padding: "0 22px 6px", textAlign: "center", color: "var(--ink-soft)", fontSize: "var(--text-sm)" }}>
              {t("pendingActivation")}
            </div>
          )}

          <div style={{ padding: "12px 22px 8px" }}>
            <button onClick={handleSubscribe} disabled={submitting} className="tap" style={{
              width: "100%", background: submitting ? "var(--hairline-strong)" : "var(--accent)",
              color: "var(--accent-ink)", border: "1px solid var(--accent)",
              borderRadius: "var(--radius-md)",
              padding: "16px 18px", fontFamily: "inherit", fontSize: "var(--text-sm)", letterSpacing: "0.06em",
              cursor: submitting ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            }}>
              {submitting ? t("processing") : t("subscribeCta")}
            </button>
          </div>

          <div style={{ padding: "4px 22px 4px", textAlign: "center" }}>
            <div className="mono-up" style={{ opacity: 0.45, fontSize: 8 }}>
              {t("fineprint")}
            </div>
          </div>

          <div style={{ padding: "0 22px 4px", textAlign: "center" }}>
            <button
              onClick={() => void subscribe(true)}
              disabled={submitting}
              className="tap"
              style={{
                background: "none",
                border: "none",
                color: "var(--ink)",
                fontSize: "var(--text-xs)",
                letterSpacing: "0.06em",
                textDecoration: "underline",
                opacity: 0.7,
                cursor: submitting ? "not-allowed" : "pointer",
                padding: "6px",
              }}
            >
              {t("useNewCard")}
            </button>
          </div>

          <div style={{ padding: "6px 22px 16px" }}>
            <button onClick={onClose} className="tap" style={{
              width: "100%", background: "none", border: "none", color: "var(--ink)",
              padding: "10px", fontSize: "var(--text-xs)", letterSpacing: "0.18em",
              textTransform: "uppercase", opacity: 0.5, cursor: "pointer",
            }}>
              {t("later")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
