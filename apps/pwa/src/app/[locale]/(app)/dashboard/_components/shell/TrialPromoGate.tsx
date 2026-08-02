"use client";
import * as React from "react";
import { useDashboard } from "../context";

/**
 * Single app-open beacon + paced upsell trigger.
 *
 * On a fresh app-open (once per 30-min idle window, shared across tabs) it
 * fires /api/app-open — this ALWAYS records the open (app_open_count +
 * last_active_at) regardless of the promo flag, because the counter is also
 * plain retention telemetry.
 *
 * It then decides whether to surface the upsell sheet. The cadence is the
 * useful part and is product-agnostic: never on the first open (let them look
 * around), then on the 2nd+ open, then not again until the 5th+ open, and never
 * more than twice in a lifetime. Showings are counted in localStorage rather
 * than the database — the boilerplate's baseline schema has no promo-seen
 * column, and getting this slightly wrong across devices is a far smaller cost
 * than a migration every product has to carry.
 *
 * TODO(new product): if you want the cap enforced server-side, add a
 * `promo_seen` counter to user_prefs and read it back from /api/app-open.
 */

const LAST_OPEN_KEY = "app:last_open_at";
const PROMO_SEEN_KEY = "app:promo_seen_count";
const OPEN_WINDOW_MS = 30 * 60 * 1000;
const MAX_SHOWINGS = 2;
const PROMO_ENABLED = process.env.NEXT_PUBLIC_TRIAL_PROMO_ENABLED === "true";

type AppOpenResult = {
  appOpenCount?: number | null;
};

function readSeenCount(): number {
  try {
    return Number(localStorage.getItem(PROMO_SEEN_KEY)) || 0;
  } catch {
    // Storage blocked: treat as never shown. The cap degrades, nothing breaks.
    return 0;
  }
}

export function shouldShowPromo(
  result: AppOpenResult,
  hasPremium: boolean,
  seen: number,
): boolean {
  if (!PROMO_ENABLED) return false;
  if (hasPremium) return false;
  if (seen >= MAX_SHOWINGS) return false;
  const count = result.appOpenCount ?? 0;
  // First showing on the 2nd+ open; second showing spaced to the 5th+ open.
  return seen === 0 ? count >= 2 : count >= 5;
}

export function TrialPromoGate() {
  const { hasPremium, openPaywall } = useDashboard();
  const ran = React.useRef(false);
  // Latest values, readable inside the one-shot effect below without making it
  // a dependency — re-running the effect would re-fire the beacon.
  const hasPremiumRef = React.useRef(hasPremium);
  const openPaywallRef = React.useRef(openPaywall);
  React.useEffect(() => {
    hasPremiumRef.current = hasPremium;
    openPaywallRef.current = openPaywall;
  }, [hasPremium, openPaywall]);

  React.useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    let last = 0;
    try {
      last = Number(localStorage.getItem(LAST_OPEN_KEY)) || 0;
    } catch {
      // Storage blocked: treat as a fresh open.
    }
    // Only beacon on a genuine app-open (fresh idle window), not on same-session
    // navigation. A recent beacon means we neither re-count nor re-evaluate.
    if (last && Date.now() - last < OPEN_WINDOW_MS) return;
    try {
      localStorage.setItem(LAST_OPEN_KEY, String(Date.now()));
    } catch {
      // Non-fatal.
    }

    void (async () => {
      let result: AppOpenResult;
      try {
        const res = await fetch("/api/app-open", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!res.ok) return;
        result = (await res.json()) as AppOpenResult;
      } catch {
        // Tracking + promo are best-effort; never surface a beacon failure.
        return;
      }

      const seen = readSeenCount();
      if (!shouldShowPromo(result, hasPremiumRef.current, seen)) return;
      try {
        localStorage.setItem(PROMO_SEEN_KEY, String(seen + 1));
      } catch {
        // Non-fatal: worst case the promo shows once more than intended.
      }
      openPaywallRef.current();
    })();
  }, []);

  // The sheet itself is owned by DashboardShell; this component only decides
  // when to ask for it, so it renders nothing.
  return null;
}
