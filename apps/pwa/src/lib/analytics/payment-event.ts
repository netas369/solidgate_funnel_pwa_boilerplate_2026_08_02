import { PRODUCT_ID_TO_DISPLAY_NAME } from "@repo/shared/solidgate/catalog";
import { PRODUCT_CODE_PATTERN } from "@/lib/pwa-products";

export type ConfirmedPurchaseEventName = "purchase_completed" | "oto_subscription_started";

export interface ConfirmedPurchase {
  event_name: ConfirmedPurchaseEventName;
  order_id: string;
  transaction_id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  product_slug: string;
  amount_cents: number;
  currency: string;
  subscription_id: string | null;
  solidgate_product_id: string | null;
  price_id: string | null;
  billing_type: "one_time" | "subscription_initial";
  provider: "solidgate";
  source: "pwa";
}

export function buildConfirmedPurchase(params: {
  orderId: string;
  productCode: string;
  productName?: string | null;
  productSlug: string;
  amountCents: number;
  currency: string;
  subscriptionId?: string | null;
  solidgateProductId?: string | null;
  priceId?: string | null;
}): ConfirmedPurchase {
  const subscriptionId = params.subscriptionId ?? null;
  const candidateName = params.productName?.trim() || null;
  const mappedName = (PRODUCT_ID_TO_DISPLAY_NAME as Record<string, string>)[params.productSlug];
  const candidateIsTechnical = candidateName === params.productCode ||
    candidateName === params.productSlug ||
    PRODUCT_CODE_PATTERN.test(candidateName ?? "");
  return {
    event_name: subscriptionId ? "oto_subscription_started" : "purchase_completed",
    order_id: params.orderId,
    transaction_id: params.orderId,
    // The canonical commerce contract uses the stable offering code as product_id. Keep
    // the native Solidgate UUID in its own unambiguous field.
    product_id: params.productCode,
    product_code: params.productCode,
    // Keep the data-team dimension stable across the hosted form, saved-card
    // path and webhook payloads. Solidgate catalog labels are presentation
    // text and may include trial suffixes, so our offering map is authoritative.
    product_name: mappedName ?? (
      candidateName && !candidateIsTechnical ? candidateName : params.productCode
    ),
    product_slug: params.productSlug,
    amount_cents: params.amountCents,
    currency: params.currency.toUpperCase(),
    subscription_id: subscriptionId,
    solidgate_product_id: params.solidgateProductId ?? null,
    price_id: params.priceId ?? null,
    billing_type: subscriptionId ? "subscription_initial" : "one_time",
    provider: "solidgate",
    source: "pwa",
  };
}

/**
 * Browser acknowledgement is intentionally a different event from the
 * webhook's canonical revenue event. PostHog deduplication also considers the
 * timestamp, so sharing only the webhook UUID would not prevent double revenue.
 */
export async function clientConfirmedPurchaseInsertId(orderId: string): Promise<string> {
  const input = `solidgate:client-confirmed:${orderId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function clientConfirmedPurchaseProperties(payment: ConfirmedPurchase, insertId: string) {
  const { event_name: serverEventName, ...commerce } = payment;
  return {
    ...commerce,
    server_event_name: serverEventName,
    // Match the canonical webhook contract: `product` is the stable offering
    // slug; the friendly label remains available as `product_name`.
    product: payment.product_slug,
    solidgate_order_id: payment.order_id,
    solidgate_subscription_id: payment.subscription_id,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    app: "pwa",
    $insert_id: insertId,
  };
}
