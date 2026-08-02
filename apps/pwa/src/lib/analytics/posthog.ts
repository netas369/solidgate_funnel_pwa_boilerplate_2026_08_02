import posthog from "posthog-js";
import {
  clientConfirmedPurchaseInsertId,
  clientConfirmedPurchaseProperties,
  type ConfirmedPurchase,
} from "./payment-event";
import { acquisitionEventProperties, type AcquisitionUtm } from "./acquisition";

/**
 * localStorage/cookie namespace for the PostHog persistence store. Distinct
 * from the funnel's so a shared apex domain cannot cross-write the two apps'
 * distinct_ids.
 *
 * TODO(new product): rename with the brand. Changing it later resets every
 * existing visitor's anonymous id.
 */
const PWA_ANALYTICS_PERSISTENCE_NAME = "acme_pwa";

let initialized = false;
let identifiedUserId: string | null = null;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function initializePwaAnalytics(
  userId: string,
  locale: string,
  acquisition?: AcquisitionUtm,
): boolean {
  if (typeof window === "undefined") return false;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;

  if (!initialized) {
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      // Latest behavior bundle supported by the pinned SDK. All privacy-
      // relevant switches below remain explicit rather than inherited.
      defaults: "2026-01-30",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      capture_exceptions: false,
      capture_heatmaps: false,
      person_profiles: "identified_only",
      persistence_name: PWA_ANALYTICS_PERSISTENCE_NAME,
      before_send: (event) => {
        const insertId = event?.properties?.$insert_id;
        return event && isUuid(insertId) ? { ...event, uuid: insertId } : event;
      },
    });
    initialized = true;
    // Capturing is on for everyone. Flip any opt-out persisted by the retired
    // consent banner back to opted-in, without emitting an $opt_in event.
    if (posthog.has_opted_out_capturing()) {
      posthog.opt_in_capturing({ captureEventName: null });
    }
  }

  // The opaque Supabase UUID is the shared join key for browser and webhook
  // events. Never attach email, name, birth details, or journal content.
  if (identifiedUserId !== userId) {
    posthog.identify(userId);
    identifiedUserId = userId;
  }
  posthog.register({
    app: "pwa",
    locale,
    ...acquisitionEventProperties(acquisition),
  });
  return true;
}

export function capturePwaPageView(pathname: string, locale: string): void {
  if (!initialized) return;
  // Search parameters can contain auth/redirect material. Page-level analysis
  // needs the route, not those values.
  posthog.capture("$pageview", {
    $current_url: pathname,
    app: "pwa",
    locale,
  });
}

/** Break the browser-to-account link before another user can use this device. */
export function resetPwaAnalytics(): void {
  if (typeof window === "undefined" || !initialized) return;
  posthog.reset();
  identifiedUserId = null;
}

export async function captureConfirmedPurchase(payment: ConfirmedPurchase): Promise<void> {
  if (typeof window === "undefined" || !initialized) return;

  const storageKey = `posthog:solidgate:client-confirmed:${payment.order_id}`;
  if (sessionStorage.getItem(storageKey)) return;
  sessionStorage.setItem(storageKey, "1");

  const insertId = await clientConfirmedPurchaseInsertId(payment.order_id);
  posthog.capture(
    "purchase_confirmed_client",
    clientConfirmedPurchaseProperties(payment, insertId),
    { send_instantly: true },
  );
}
