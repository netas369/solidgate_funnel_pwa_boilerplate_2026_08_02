"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { startPurchase, confirmPurchase, type MerchantData } from "@/lib/solidgate/checkout";
import { SolidgatePaymentForm } from "@/components/solidgate/SolidgatePaymentForm";

/** A purchasable one-time product, as the member area needs to render it. */
export interface PurchasableItem {
  /** ProductId from @repo/shared/price-map. Must be in PWA_SLUGS. */
  slug: string;
  /** Human title shown in the sheet. */
  label: string;
  /** Locale-formatted price string (e.g. "€19.00"), or "" while unresolved. */
  price: string;
  /** Optional visual. Pass inline SVG or a coloured block — NOT an <img> to a
   *  file, the boilerplate ships no product artwork. */
  cover?: React.ReactNode;
}

interface Props {
  item: PurchasableItem;
  locale: string;
  onClose: () => void;
}

/**
 * One-time (non-subscription) in-app purchase. One click on the vaulted card;
 * the hosted form collects one when the account has none (or theirs died).
 *
 * This is the boilerplate's only example of a NON-recurring purchase — the
 * paywall sells the subscription, this sells a single product. Same order
 * machine, different grant shape server-side.
 */
export function ProductPurchaseSheet({ item, locale, onClose }: Props) {
  const t = useTranslations("pwa.purchase");
  const tPayment = useTranslations("pwa.payment");
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [confirmingHosted, setConfirmingHosted] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [pendingOrderId, setPendingOrderId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Solidgate: set when no usable card is on the account and the hosted form
  // must collect one. Confirming that order grants the PDF AND vaults the card.
  const [sgForm, setSgForm] = React.useState<{ merchantData: MerchantData; orderId: string } | null>(null);

  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const succeed = React.useCallback(() => {
    router.refresh();
    onClose();
  }, [router, onClose]);

  const rememberPending = React.useCallback((orderId?: string) => {
    setPending(true);
    setPendingOrderId(orderId ?? null);
  }, []);

  const clearPending = React.useCallback(() => {
    setPending(false);
    setPendingOrderId(null);
  }, []);

  const replaceTerminalOrder = React.useCallback(async (terminalOrderId: string) => {
    const replacement = await startPurchase({ slug: item.slug, locale, forceForm: true });
    if (replacement.kind === "granted" || replacement.kind === "already_owned") {
      succeed();
      return;
    }
    if (replacement.kind === "needs_card" && replacement.orderId !== terminalOrderId) {
      clearPending();
      setSgForm({ merchantData: replacement.merchantData, orderId: replacement.orderId });
      return;
    }

    // The submitted identity is terminal, but no distinct replacement form was
    // proven. Keep its UI inert and make another click repeat this safe sequence.
    rememberPending(terminalOrderId);
    if (replacement.kind === "failed" || replacement.kind === "redirect") setError(t("error"));
  }, [clearPending, item.slug, locale, rememberPending, succeed, t]);

  const buyWithSaved = React.useCallback(async () => {
    if (submitting) return;
    const orderToConfirm = pending ? pendingOrderId : null;
    setSubmitting(true);
    setPending(false);
    setError(null);
    try {
      const outcome = orderToConfirm
        ? await confirmPurchase(orderToConfirm)
        : await startPurchase({ slug: item.slug, locale });
      if (outcome.kind === "granted" || outcome.kind === "already_owned") {
        succeed();
        return;
      }
      if (outcome.kind === "recovery_required") {
        window.location.assign("/billing/update-payment");
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
        // Once an identity is known, only confirm that exact provider order.
        // A no-ID transport failure may safely retry the atomic opener.
        rememberPending(outcome.orderId ?? orderToConfirm ?? undefined);
        return;
      }
      if (outcome.httpStatus === 402 && outcome.orderId) {
        await replaceTerminalOrder(outcome.orderId);
        return;
      }
      clearPending();
      setError(t("error"));
    } catch {
      if (orderToConfirm) rememberPending(orderToConfirm);
      else setError(t("error"));
    } finally {
      setSubmitting(false);
    }
  }, [
    clearPending,
    item.slug,
    locale,
    pending,
    pendingOrderId,
    rememberPending,
    replaceTerminalOrder,
    submitting,
    succeed,
    t,
  ]);

  const confirmHostedPurchase = React.useCallback(async (orderId: string) => {
    if (confirmingHosted) return;
    setConfirmingHosted(true);
    setPending(false);
    setError(null);
    try {
      const outcome = await confirmPurchase(orderId);
      if (outcome.kind === "granted") {
        succeed();
        return;
      }
      if (outcome.kind === "pending") {
        // The hosted form has already submitted this merchant order. Never
        // mount it again as a fresh payment; retry only server confirmation.
        rememberPending(orderId);
        return;
      }
      if (outcome.kind === "failed" && outcome.httpStatus === 402) {
        await replaceTerminalOrder(orderId);
        return;
      }
      rememberPending(orderId);
      setError(t("error"));
    } catch {
      rememberPending(orderId);
      setError(t("error"));
    } finally {
      setConfirmingHosted(false);
    }
  }, [confirmingHosted, rememberPending, replaceTerminalOrder, succeed, t]);

  if (sgForm) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: "var(--z-sheet)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim)" }} />
        <div style={{ position: "relative", width: "100%", background: "var(--paper)", borderTop: "1px solid var(--ink)", padding: 20, maxHeight: "92%", overflowY: "auto" }}>
          <p className="mono-up" style={{ marginBottom: 12, color: "var(--ink-soft)" }}>{item.label} · {item.price}</p>
          <SolidgatePaymentForm
            merchantData={sgForm.merchantData}
            orderId={sgForm.orderId}
            buttonText={t("cta")}
            enableApplePay
            savedMethodDisclosure={tPayment("savedMethodDisclosure")}
            onPaid={(orderId) => void confirmHostedPurchase(orderId)}
            onFail={() => setError(t("error"))}
          />
          {(confirmingHosted || pending) && (
            <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
              <p role="status" aria-live="polite" style={{ color: "var(--ink-soft)", margin: 0 }}>
                {t("processing")}
              </p>
              {pending && (
                <button
                  type="button"
                  onClick={() => void confirmHostedPurchase(sgForm.orderId)}
                  className="tap"
                  style={{ marginTop: 14, padding: "12px 18px" }}
                >
                  {t("cta")}
                </button>
              )}
            </div>
          )}
          {error && <p style={{ color: "var(--danger)", textAlign: "center", marginTop: 10 }}>{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: "var(--z-sheet)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--scrim)", animation: "appFadeUp .25s ease" }} />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 560,
          background: "var(--paper)",
          borderTop: "1px solid var(--ink)",
          animation: "appFadeUp .4s cubic-bezier(.4,0,.2,1)",
          maxHeight: "92%",
          color: "var(--ink-soft)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "14px 0", flexShrink: 0 }}>
          <div style={{ width: 36, height: 3, background: "var(--hairline-strong)", borderRadius: 2, margin: "0 auto" }} />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch", padding: "4px 26px 8px" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            {item.cover && (
              <div style={{ flexShrink: 0, border: "1px solid var(--hairline-strong)", background: "var(--paper-soft)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
                {item.cover}
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="mono-up" style={{ fontSize: 8.5, letterSpacing: "0.22em", opacity: 0.55 }}>
                {t("kicker")}
              </div>
              <h2 className="display" style={{ fontSize: "var(--text-xl)", lineHeight: 1.1, margin: "6px 0 0", fontWeight: 600, color: "var(--ink)" }}>
                {item.label}
              </h2>
            </div>
          </div>

          <p className="body-sans" style={{ margin: "16px 0 0", opacity: 0.72 }}>
            {t("subtitle")}
          </p>
        </div>

        {(
          <div style={{ flexShrink: 0, borderTop: "1px solid var(--hairline)", background: "var(--paper)", paddingBottom: "env(safe-area-inset-bottom)" }}>
            {error && (
              <div role="alert" style={{ padding: "10px 22px 0", textAlign: "center", color: "var(--danger)", fontSize: 13 }}>
                {error}
              </div>
            )}
            {pending && (
              <div role="status" aria-live="polite" style={{ padding: "10px 22px 0", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
                {t("processing")}
              </div>
            )}
            <div style={{ padding: "14px 22px 8px" }}>
              <button
                onClick={buyWithSaved}
                disabled={submitting}
                className="tap"
                style={{
                  width: "100%",
                  background: submitting ? "var(--hairline-strong)" : "var(--accent)",
                  color: "var(--accent-ink)",
                  border: "1px solid var(--accent)",
                  padding: "16px 18px",
                  borderRadius: "var(--radius-md)",
                  fontFamily: "inherit",
                  fontSize: "var(--text-sm)",
                  letterSpacing: "0.06em",
                  cursor: submitting ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                {submitting ? t("processing") : (
                  <>
                    <span>{t("cta")}</span>
                    {item.price && (
                      <>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span>{item.price}</span>
                      </>
                    )}
                  </>
                )}
              </button>
            </div>
            <div style={{ padding: "0 22px 6px", textAlign: "center" }}>
              <div className="mono-up" style={{ opacity: 0.45, fontSize: 8 }}>{t("fineprint")}</div>
            </div>
            <div style={{ padding: "4px 22px 16px" }}>
              <button onClick={onClose} className="tap" style={{ width: "100%", background: "none", border: "none", color: "var(--ink)", padding: 10, fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.5, cursor: "pointer" }}>
                {t("later")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
