"use client";

import {
  clientConfirmedPurchaseInsertId,
  clientConfirmedPurchaseProperties,
  type ConfirmedPurchase,
} from "./payment-event";
import { acquisitionEventProperties, type AcquisitionUtm } from "./acquisition";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

function newEventKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Send authenticated member-area telemetry to the internal event store. */
export async function capturePwaEvent(
  eventName: string,
  properties?: Record<string, unknown>,
  options: { eventKey?: string; keepalive?: boolean } = {},
): Promise<boolean> {
  if (typeof window === "undefined" || !EVENT_NAME_PATTERN.test(eventName)) return false;

  try {
    const response = await fetch("/api/analytics/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: options.keepalive ?? false,
      body: JSON.stringify({
        eventName,
        eventKey: options.eventKey ?? newEventKey(),
        properties: properties ?? {},
      }),
    });
    return response.ok;
  } catch {
    // Analytics must never interrupt the member experience.
    return false;
  }
}

export function capturePwaPageView(
  pathname: string,
  locale: string,
  acquisition?: AcquisitionUtm,
): Promise<boolean> {
  // Deliberately exclude search parameters, which may contain auth or redirect
  // material. Route-level reporting only needs the normalized pathname.
  return capturePwaEvent("page_view", {
    path: pathname,
    locale,
    ...acquisitionEventProperties(acquisition),
  });
}

export async function captureConfirmedPurchase(payment: ConfirmedPurchase): Promise<void> {
  if (typeof window === "undefined") return;

  const storageKey = `internal-analytics:solidgate:client-confirmed:${payment.order_id}`;
  if (sessionStorage.getItem(storageKey)) return;

  const insertId = await clientConfirmedPurchaseInsertId(payment.order_id);
  const captured = await capturePwaEvent(
    "purchase_confirmed_client",
    clientConfirmedPurchaseProperties(payment, insertId),
    { eventKey: `purchase-confirmed-client:${insertId}` },
  );
  if (captured) sessionStorage.setItem(storageKey, "1");
}
