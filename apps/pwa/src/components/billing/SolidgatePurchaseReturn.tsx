"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  confirmPurchaseAfterRedirect,
  type PurchaseOutcome,
} from "@/lib/solidgate/checkout";

type Recovery = {
  key: string;
  promise: Promise<PurchaseOutcome>;
};

type RetryBudget = {
  key: string;
  startedAt: number;
  cyclesStarted: number;
  nextAttemptAt: number;
};

type DisplayState = {
  key: string;
  phase: "processing" | "pending" | "consumed";
};

export const PWA_RETURN_RETRY_DELAY_MS = 15_000;
export const PWA_RETURN_MAX_AUTO_CYCLES = 3;
export const PWA_RETURN_MAX_AUTO_AGE_MS = 60_000;

/**
 * Completes a saved-card 3DS purchase after Solidgate returns to the PWA.
 * The query value is only a lookup key: purchase/confirm binds the order to
 * the authenticated user and re-reads its status directly from Solidgate.
 */
export function SolidgatePurchaseReturn() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tCheckout = useTranslations("common.checkout");
  const recovery = useRef<Recovery | null>(null);
  const retryBudget = useRef<RetryBudget | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [display, setDisplay] = useState<DisplayState | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const query = searchParams.toString();
  const orderId = searchParams.get("sg_confirm");
  // The provider lookup identity is the exact order, not the rest of the URL.
  // Cosmetic query changes therefore cannot reset the shared retry budget.
  const recoveryKey = orderId;

  useEffect(() => {
    if (!orderId || !recoveryKey) return;

    let active = true;
    const now = Date.now();
    let budget = retryBudget.current;
    if (!budget || budget.key !== recoveryKey) {
      budget = {
        key: recoveryKey,
        startedAt: now,
        cyclesStarted: 0,
        nextAttemptAt: now,
      };
      retryBudget.current = budget;
    }
    const ageMs = now - budget.startedAt;
    const exhausted =
      budget.cyclesStarted >= PWA_RETURN_MAX_AUTO_CYCLES
      || ageMs >= PWA_RETURN_MAX_AUTO_AGE_MS;
    if (exhausted) return;
    if (budget.nextAttemptAt > now) {
      const waitMs = Math.min(
        budget.nextAttemptAt - now,
        PWA_RETURN_MAX_AUTO_AGE_MS - ageMs,
      );
      retryTimer.current = setTimeout(() => {
        if (!active) return;
        retryTimer.current = null;
        setRetryGeneration((generation) => generation + 1);
      }, waitMs);
      return () => {
        active = false;
        if (retryTimer.current) {
          clearTimeout(retryTimer.current);
          retryTimer.current = null;
        }
      };
    }

    let current = recovery.current;
    if (!current || current.key !== recoveryKey) {
      const remainingAgeMs = Math.max(
        1,
        PWA_RETURN_MAX_AUTO_AGE_MS - (Date.now() - budget.startedAt),
      );
      budget.cyclesStarted += 1;
      current = {
        key: recoveryKey,
        // A transport failure is ambiguous, so it has the same durable outcome
        // as exhausting the bounded status checks: retain the return param for a
        // later refresh instead of consuming the only recovery identity.
        promise: confirmPurchaseAfterRedirect(
          orderId,
          { timeoutMs: remainingAgeMs },
        ).catch((): PurchaseOutcome => ({
          kind: "pending",
          orderId,
        })),
      };
      recovery.current = current;
    }
    const activeRecovery = current;

    void activeRecovery.promise.then((outcome) => {
      if (!active || recovery.current !== activeRecovery) return;

      // Keep the lookup on a still-pending order: a refresh can safely resume
      // it after the webhook settles. Terminal outcomes are consumed once.
      if (outcome.kind === "pending") {
        recovery.current = null;
        setDisplay({ key: recoveryKey, phase: "pending" });
        const latestBudget = retryBudget.current;
        if (!latestBudget || latestBudget.key !== recoveryKey) return;
        const retryAt = Date.now() + PWA_RETURN_RETRY_DELAY_MS;
        latestBudget.nextAttemptAt = retryAt;
        if (
          latestBudget.cyclesStarted >= PWA_RETURN_MAX_AUTO_CYCLES
          || retryAt - latestBudget.startedAt >= PWA_RETURN_MAX_AUTO_AGE_MS
        ) return;
        retryTimer.current = setTimeout(() => {
          if (!active) return;
          retryTimer.current = null;
          setRetryGeneration((generation) => generation + 1);
        }, PWA_RETURN_RETRY_DELAY_MS);
        return;
      }

      recovery.current = null;
      setDisplay({ key: recoveryKey, phase: "consumed" });
      const next = new URLSearchParams(query);
      next.delete("sg_confirm");
      const nextQuery = next.toString();
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
      if (outcome.kind === "granted") router.refresh();
    });

    return () => {
      // StrictMode immediately subscribes again to the same promise. Do not
      // cancel or mark the shared recovery as attempted: that used to discard
      // the only result between the synthetic cleanup and second effect.
      active = false;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [orderId, pathname, query, recoveryKey, retryGeneration, router]);

  if (!recoveryKey) return null;
  const phase = display?.key === recoveryKey ? display.phase : "processing";
  if (phase === "consumed") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={phase === "processing"}
      data-payment-recovery-state={phase}
      className="pointer-events-none fixed inset-x-4 bottom-5 z-[100] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-white/15 bg-slate-950/95 px-4 py-3 text-sm font-medium text-white shadow-2xl backdrop-blur"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white"
      />
      <span>
        {phase === "processing"
          ? tCheckout("completingVerification")
          : tCheckout("processing")}
      </span>
    </div>
  );
}
