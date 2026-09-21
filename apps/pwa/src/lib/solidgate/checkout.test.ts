import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmedPurchase } from "@/lib/analytics/payment-event";

const captureConfirmedPurchase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/posthog", () => ({ captureConfirmedPurchase }));

import {
  confirmPurchase,
  confirmPurchaseAfterRedirect,
  PWA_PAYMENT_REQUEST_TIMEOUT_MS,
  PWA_REDIRECT_CONFIRM_TIMEOUT_MS,
  startPurchase,
} from "./checkout";

const payment: ConfirmedPurchase = {
  event_name: "purchase_completed",
  order_id: "u-user:oto3_bundle_all:1",
  transaction_id: "u-user:oto3_bundle_all:1",
  product_id: "BRANDBUNDLE_000000_PDF",
  product_code: "BRANDBUNDLE_000000_PDF",
  product_name: "Bundle (all)",
  product_slug: "oto3_bundle_all",
  amount_cents: 3000,
  currency: "EUR",
  subscription_id: null,
  solidgate_product_id: null,
  price_id: null,
  billing_type: "one_time",
  provider: "solidgate",
  source: "pwa",
};

describe("PWA checkout analytics boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("captures only the server-confirmed payment payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      payment,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(confirmPurchase(payment.order_id)).resolves.toEqual({ kind: "granted", payment });
    expect(captureConfirmedPurchase).toHaveBeenCalledOnce();
    expect(captureConfirmedPurchase).toHaveBeenCalledWith(payment);
  });

  it("does not capture a still-settling payment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      pending: true,
    }), { status: 202, headers: { "content-type": "application/json" } })));

    await expect(confirmPurchase(payment.order_id)).resolves.toEqual({
      kind: "pending",
      orderId: payment.order_id,
    });
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });

  it("bounds an ambiguous confirmation request and keeps it pending", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected payment request deadline");
      requestSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }));

    const confirmation = confirmPurchase(payment.order_id);
    await vi.advanceTimersByTimeAsync(PWA_PAYMENT_REQUEST_TIMEOUT_MS);

    await expect(confirmation).resolves.toEqual({
      kind: "pending",
      orderId: payment.order_id,
    });
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });

  it("does not capture a failed or voided payment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      terminal: true,
      error: "Payment authorization was voided",
      code: "void_ok",
      status: "void_ok",
    }), { status: 402, headers: { "content-type": "application/json" } })));

    await expect(confirmPurchase(payment.order_id)).resolves.toEqual({
      kind: "failed",
      error: "Payment authorization was voided",
      code: "void_ok",
      status: "void_ok",
      httpStatus: 402,
      orderId: payment.order_id,
    });
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });

  it.each([408, 425, 429, 500, 502, 503])(
    "keeps a parsed retryable HTTP %i confirmation pending on the exact order",
    async (httpStatus) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ok: false,
        // Even a contradictory body cannot turn an ambiguous transport/server
        // response into proof that the card itself terminally failed.
        terminal: true,
        orderId: payment.order_id,
        status: "auth_failed",
        error: "Temporary confirmation failure",
      }), { status: httpStatus, headers: { "content-type": "application/json" } })));

      await expect(confirmPurchase(payment.order_id)).resolves.toEqual({
        kind: "pending",
        orderId: payment.order_id,
      });
      expect(captureConfirmedPurchase).not.toHaveBeenCalled();
    },
  );

  it("keeps a parsed nonterminal application response pending", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      orderId: payment.order_id,
      code: "grant_revoked",
      error: "Purchase state is not grantable yet",
    }), { status: 409, headers: { "content-type": "application/json" } })));

    await expect(confirmPurchase(payment.order_id)).resolves.toEqual({
      kind: "pending",
      orderId: payment.order_id,
    });
  });

  it("rechecks a 3DS return until Solidgate settles, then captures once", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, pending: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, payment }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })));

    await expect(confirmPurchaseAfterRedirect(payment.order_id, {
      attempts: 2,
      intervalMs: 0,
    })).resolves.toEqual({ kind: "granted", payment });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(captureConfirmedPurchase).toHaveBeenCalledOnce();
  });

  it("exhausts parsed retryable responses as pending without losing the return order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "request timeout" }), {
        status: 408,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "too early" }), {
        status: 425,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "upstream unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmPurchaseAfterRedirect(payment.order_id, {
      attempts: 3,
      intervalMs: 0,
    })).resolves.toEqual({
      kind: "pending",
      orderId: payment.order_id,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });

  it("uses one bounded wall-clock deadline for all post-3DS checks", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected payment request deadline");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const confirmation = confirmPurchaseAfterRedirect(payment.order_id);
    await vi.advanceTimersByTimeAsync(PWA_REDIRECT_CONFIRM_TIMEOUT_MS - 1);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await expect(confirmation).resolves.toEqual({
      kind: "pending",
      orderId: payment.order_id,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });
});

describe("PWA checkout order identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the order id returned by an accepted atomic opener", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      pending: true,
      orderId: "saved-order-1",
    }), { status: 202, headers: { "content-type": "application/json" } })));

    await expect(startPurchase({ slug: "oto5_pdf", locale: "en" })).resolves.toEqual({
      kind: "pending",
      orderId: "saved-order-1",
    });
  });

  it("keeps the exact confirmation input on transport and body ambiguity", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response("not-json", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        pending: true,
        orderId: "untrusted-response-order",
      }), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(confirmPurchase("submitted-order")).resolves.toEqual({
      kind: "pending",
      orderId: "submitted-order",
    });
    await expect(confirmPurchase("submitted-order")).resolves.toEqual({
      kind: "pending",
      orderId: "submitted-order",
    });
    await expect(confirmPurchase("submitted-order")).resolves.toEqual({
      kind: "pending",
      orderId: "submitted-order",
    });
  });

  it("never adopts a mismatched response identity while confirming", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      terminal: true,
      orderId: "different-order",
      status: "declined",
      error: "Payment not completed",
    }), { status: 402, headers: { "content-type": "application/json" } })));

    await expect(confirmPurchase("submitted-order")).resolves.toEqual({
      kind: "pending",
      orderId: "submitted-order",
    });
  });

  it("does not open a replacement from a malformed nonterminal needsNewCard body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      needsNewCard: true,
      orderId: "saved-order-1",
      status: "declined",
      error: "Malformed response",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startPurchase({ slug: "oto5_pdf", locale: "en" })).resolves.toEqual({
      kind: "failed",
      error: "Malformed response",
      status: "declined",
      httpStatus: 200,
      orderId: "saved-order-1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts a terminal retry form only when the opener advances to a new order", async () => {
    const merchantData = {
      merchant: "merchant",
      paymentIntent: "intent-next",
      signature: "signature-next",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        needsNewCard: true,
        orderId: "saved-order-1",
        status: "declined",
        code: "payment_failed",
        error: "Payment not completed",
      }), { status: 402, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        needsCard: true,
        orderId: "saved-order-2",
        merchantData,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startPurchase({ slug: "oto5_pdf", locale: "en" })).resolves.toEqual({
      kind: "needs_card",
      orderId: "saved-order-2",
      merchantData,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      slug: "oto5_pdf",
      locale: "en",
      forceForm: true,
    });
  });

  it("fails closed when a terminal retry returns the same submitted order", async () => {
    const terminal = {
      ok: false,
      needsNewCard: true,
      orderId: "saved-order-1",
      status: "declined",
      code: "payment_failed",
      error: "Payment not completed",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(terminal), {
        status: 402,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        needsCard: true,
        orderId: "saved-order-1",
        merchantData: {
          merchant: "merchant",
          paymentIntent: "same-intent",
          signature: "same-signature",
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startPurchase({ slug: "oto5_pdf", locale: "en" })).resolves.toEqual({
      kind: "failed",
      error: "Payment not completed",
      code: "payment_failed",
      status: "declined",
      httpStatus: 402,
      orderId: "saved-order-1",
    });
  });
  it('routes a past-due add-on to existing-subscription recovery without another checkout attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: false, recoveryRequired: true }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(startPurchase({ slug: 'oto2_addon_weekly', locale: 'en' })).resolves.toEqual({ kind: 'recovery_required' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captureConfirmedPurchase).not.toHaveBeenCalled();
  });

});
