import { describe, expect, it } from "vitest";
import {
  buildConfirmedPurchase,
  clientConfirmedPurchaseInsertId,
  clientConfirmedPurchaseProperties,
} from "./payment-event";

describe("PWA confirmed purchase analytics contract", () => {
  it("builds Stripe-compatible product fields without duplicating webhook revenue", async () => {
    const payment = buildConfirmedPurchase({
      orderId: "u-11111111-1111-1111-1111-111111111111:oto3_bundle_all:1",
      productCode: "BRANDBUNDLE_000000_PDF",
      productName: "Provider catalog label",
      productSlug: "oto3_bundle_all",
      amountCents: 3000,
      currency: "eur",
    });
    const insertId = await clientConfirmedPurchaseInsertId(payment.order_id);
    const properties = clientConfirmedPurchaseProperties(payment, insertId);

    expect(payment).toMatchObject({
      event_name: "purchase_completed",
      order_id: payment.order_id,
      transaction_id: payment.order_id,
      product_id: "BRANDBUNDLE_000000_PDF",
      product_code: "BRANDBUNDLE_000000_PDF",
      product_name: "Bundle (all)",
      product_slug: "oto3_bundle_all",
      amount_cents: 3000,
      currency: "EUR",
      subscription_id: null,
      billing_type: "one_time",
      provider: "solidgate",
      source: "pwa",
    });
    expect(properties).toMatchObject({
      product: "oto3_bundle_all",
      solidgate_order_id: payment.order_id,
      app: "pwa",
      $insert_id: insertId,
      server_event_name: "purchase_completed",
    });
    expect(properties).not.toHaveProperty("revenue");
    expect(properties).not.toHaveProperty("event_name");
    expect(properties).not.toHaveProperty("email");
    expect(insertId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(clientConfirmedPurchaseInsertId(payment.order_id)).resolves.toBe(insertId);
  });

  it("uses the subscription lifecycle taxonomy for the paid subscription product", () => {
    expect(buildConfirmedPurchase({
      orderId: "u-user:oto2_addon_weekly:2",
      productCode: "BRANDADDON_000000_SUB",
      productSlug: "oto2_addon_weekly",
      amountCents: 4900,
      currency: "usd",
      subscriptionId: "sub_123",
      solidgateProductId: "product_uuid",
      priceId: "price_uuid",
    })).toMatchObject({
      event_name: "oto_subscription_started",
      product_name: "Weekly Add-on",
      currency: "USD",
      subscription_id: "sub_123",
      solidgate_product_id: "product_uuid",
      price_id: "price_uuid",
      billing_type: "subscription_initial",
    });
  });

  it("maps an amount-based OTO code to its canonical display name", () => {
    expect(buildConfirmedPurchase({
      orderId: "u-user:oto3_bundle_all:2",
      productCode: "BRANDBUNDLE_000000_PDF",
      productName: "BRANDBUNDLE_000000_PDF",
      productSlug: "oto3_bundle_all",
      amountCents: 3000,
      currency: "eur",
    }).product_name).toBe("Bundle (all)");
  });

  it("keeps the canonical label when Solidgate returns a mutable catalog name", () => {
    expect(buildConfirmedPurchase({
      orderId: "u-user:oto2_addon_weekly:2",
      productCode: "BRANDADDON_000000_SUB",
      productName: "Provider Weekly Label (7-day trial)",
      productSlug: "oto2_addon_weekly",
      amountCents: 0,
      currency: "eur",
      subscriptionId: "sub_123",
    }).product_name).toBe("Weekly Add-on");
  });
});
