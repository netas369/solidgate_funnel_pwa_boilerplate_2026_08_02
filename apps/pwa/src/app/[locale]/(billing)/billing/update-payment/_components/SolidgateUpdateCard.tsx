"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "@repo/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { SolidgatePaymentForm } from "@/components/solidgate/SolidgatePaymentForm";
import type { MerchantData } from "@/lib/solidgate/checkout";

const returnConfirmations = new Map<string, Promise<void>>();
const CARD_UPDATE_CONFIRM_BUDGET_MS = 120_000;
const CARD_UPDATE_REQUEST_TIMEOUT_MS = 12_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function confirmReturnedCardUpdate(orderId: string): Promise<void> {
  const existing = returnConfirmations.get(orderId);
  if (existing) return existing;
  const request = (async () => {
    const deadline = Date.now() + CARD_UPDATE_CONFIRM_BUDGET_MS;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CARD_UPDATE_REQUEST_TIMEOUT_MS);
      let response: Response | null = null;
      let retryAfterMs = 2_000;
      try {
        response = await fetch("/api/solidgate/billing/update-card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
          body: JSON.stringify({ orderId }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; pending?: boolean; retryAfterMs?: unknown };
        if (response.status === 200 && data.ok === true && data.pending !== true) return;
        if (typeof data.retryAfterMs === "number" && data.retryAfterMs >= 250) {
          retryAfterMs = Math.min(data.retryAfterMs, 10_000);
        }
      } catch {
        // A timeout or lost response is ambiguous. The durable attempt ledger
        // makes retrying this exact order safe.
      } finally {
        clearTimeout(timeout);
      }

      const retryable = response === null
        || response.status === 202
        || response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      if (!retryable || Date.now() + retryAfterMs >= deadline) {
        throw new Error("card_update_not_confirmed");
      }
      await wait(retryAfterMs);
    }
  })();
  returnConfirmations.set(orderId, request);
  void request.finally(() => {
    if (returnConfirmations.get(orderId) === request) {
      returnConfirmations.delete(orderId);
    }
  }).catch(() => undefined);
  return request;
}

async function openCardUpdate(locale: string): Promise<
  | { merchantData: MerchantData; orderId: string }
  | { resumeOrderId: string }
> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch("/api/solidgate/billing/update-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ locale }),
    });
    const data = await response.json() as {
      merchantData?: MerchantData;
      orderId?: string;
      status?: string;
      retryAfterMs?: number;
      error?: string;
    };
    if (response.ok && data.merchantData && data.orderId) {
      return { merchantData: data.merchantData, orderId: data.orderId };
    }
    if (response.status === 202 && data.orderId && data.status === "applying") {
      return { resumeOrderId: data.orderId };
    }
    const delay = Math.min(Math.max(data.retryAfterMs ?? 500, 250), 2_000);
    if (response.status !== 202 || Date.now() + delay >= deadline) {
      throw new Error(data.error ?? "card_update_open_failed");
    }
    await wait(delay);
  }
}

/**
 * "Update your card" — the recovery flow for a subscription whose rebill failed.
 *
 * Solidgate has no SetupIntent: a card is tokenised by being charged. So the
 * form runs a ZERO-AMOUNT AUTH — it takes no money but yields a reusable token.
 * Confirming it re-points billable subscriptions at the new card. Access is
 * restored by the server only after Solidgate confirms a successful retry.
 */

export function SolidgateUpdateCard({ productName }: { productName: string }) {
  const t = useTranslations("billing.update");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnOrderId = searchParams.get("sg_card_update");
  const [form, setForm] = useState<{ merchantData: MerchantData; orderId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(Boolean(returnOrderId));
  const formRequestedRef = useRef(false);
  const handledReturnOrderRef = useRef<string | null>(null);

  useEffect(() => {
    if (returnOrderId || formRequestedRef.current) return;
    formRequestedRef.current = true;
    openCardUpdate(locale)
      .then(async (result) => {
        if ("resumeOrderId" in result) {
          setBusy(true);
          await confirmReturnedCardUpdate(result.resumeOrderId);
          router.replace("/dashboard?payment_updated=1");
          return;
        }
        setForm(result);
      })
      .catch(() => setError(t("updateError")));
  }, [locale, returnOrderId, router, t]);

  useEffect(() => {
    if (!returnOrderId || handledReturnOrderRef.current === returnOrderId) return;
    handledReturnOrderRef.current = returnOrderId;
    let active = true;
    confirmReturnedCardUpdate(returnOrderId)
      .then(() => {
        if (!active) return;
        router.replace("/dashboard?payment_updated=1");
      })
      .catch(() => {
        if (!active) return;
        setBusy(false);
        setError(t("updateError"));
      });
    return () => {
      active = false;
      // React strict mode replaces the effect after cleanup. Let that effect
      // own the same exact order instead of stranding the return marker.
      if (handledReturnOrderRef.current === returnOrderId) {
        handledReturnOrderRef.current = null;
      }
    };
  }, [returnOrderId, router, t]);

  return (
    <main className="max-w-md mx-auto px-4 py-10">
      <p className="mono-up" style={{ marginBottom: 8, color: "var(--ink-soft)" }}>
        {productName}
      </p>

      {form && !returnOrderId ? (
        <div style={{ opacity: busy ? 0.6 : 1 }}>
          <SolidgatePaymentForm
            merchantData={form.merchantData}
            orderId={form.orderId}
            buttonText={t("updateSubmit")}
            onPaid={async (orderId) => {
              setBusy(true);
              try {
                await confirmReturnedCardUpdate(orderId);
                router.push("/dashboard?payment_updated=1");
              } catch {
                setBusy(false);
                setError(t("updateError"));
              }
            }}
            onFail={() => setError(t("updateError"))}
          />
        </div>
      ) : (
        !error && <div style={{ height: 240, background: "var(--paper-soft)" }} aria-busy="true" />
      )}

      {error && (
        <p role="alert" style={{ color: "var(--danger)", textAlign: "center", marginTop: 12 }}>
          {error}
        </p>
      )}
    </main>
  );
}
