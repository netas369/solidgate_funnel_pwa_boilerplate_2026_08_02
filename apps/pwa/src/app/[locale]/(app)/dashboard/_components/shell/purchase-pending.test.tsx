import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startPurchase: vi.fn(),
  confirmPurchase: vi.fn(),
  refresh: vi.fn(),
}));

const translate = Object.assign((key: string) => key, { raw: () => [] });

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => translate,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@/lib/solidgate/checkout", () => ({
  startPurchase: mocks.startPurchase,
  confirmPurchase: mocks.confirmPurchase,
}));

vi.mock("@/components/solidgate/SolidgatePaymentForm", () => ({
  SolidgatePaymentForm: ({
    orderId,
    onPaid,
  }: {
    orderId: string;
    onPaid: (orderId: string) => void;
  }) => (
    <button type="button" onClick={() => onPaid(orderId)}>
      hosted-success
    </button>
  ),
}));

import { ProductPurchaseSheet } from "./ProductPurchaseSheet";
import { PaywallSheet } from "./PaywallSheet";

const oneTimeItem = {
  slug: "oto5_pdf" as const,
  label: "Digital Product 5",
  price: "€19.00",
};

describe("PWA pending purchase UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the one-time purchase sheet open and safely resumes a saved-card pending purchase", async () => {
    mocks.startPurchase.mockResolvedValue({ kind: "pending" });
    const onClose = vi.fn();

    render(
      <ProductPurchaseSheet
        item={oneTimeItem}
        locale="en"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("processing");
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    await waitFor(() => expect(mocks.startPurchase).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("retries a known saved-card one-time order by confirming that exact id", async () => {
    mocks.startPurchase.mockResolvedValue({
      kind: "pending",
      orderId: "one-time-saved-order-1",
    });
    mocks.confirmPurchase
      .mockResolvedValueOnce({ kind: "pending", orderId: "one-time-saved-order-1" })
      .mockResolvedValueOnce({ kind: "granted" });
    const onClose = vi.fn();

    render(
      <ProductPurchaseSheet
        item={oneTimeItem}
        locale="en"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("processing");

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    await waitFor(() => expect(mocks.confirmPurchase).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenLastCalledWith("one-time-saved-order-1");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(2, "one-time-saved-order-1");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-confirms the same hosted one-time order without closing on pending", async () => {
    mocks.startPurchase.mockResolvedValue({
      kind: "needs_card",
      merchantData: { merchant: "data" },
      orderId: "one-time-order-1",
    });
    mocks.confirmPurchase
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValueOnce({ kind: "granted" });
    const onClose = vi.fn();

    render(
      <ProductPurchaseSheet
        item={oneTimeItem}
        locale="en"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    fireEvent.click(await screen.findByRole("button", { name: "hosted-success" }));

    expect(await screen.findByRole("status")).toHaveTextContent("processing");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "hosted-success" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "cta" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(1, "one-time-order-1");
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(2, "one-time-order-1");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the old hosted order inert when terminal replacement is still pending", async () => {
    mocks.startPurchase
      .mockResolvedValueOnce({
        kind: "needs_card",
        merchantData: { merchant: "data" },
        orderId: "one-time-hosted-order-1",
      })
      .mockResolvedValueOnce({
        kind: "pending",
        orderId: "unproven-replacement-order",
      });
    mocks.confirmPurchase
      .mockResolvedValueOnce({
        kind: "failed",
        error: "Payment not completed",
        status: "declined",
        httpStatus: 402,
        orderId: "one-time-hosted-order-1",
      })
      .mockResolvedValueOnce({
        kind: "pending",
        orderId: "one-time-hosted-order-1",
      });
    const onClose = vi.fn();

    render(
      <ProductPurchaseSheet
        item={oneTimeItem}
        locale="en"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /cta/ }));
    fireEvent.click(await screen.findByRole("button", { name: "hosted-success" }));

    expect(await screen.findByRole("status")).toHaveTextContent("processing");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(2);
    expect(mocks.startPurchase).toHaveBeenLastCalledWith({
      slug: oneTimeItem.slug,
      locale: "en",
      forceForm: true,
    });
    expect(screen.getByRole("button", { name: "hosted-success" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "cta" }));
    await waitFor(() => expect(mocks.confirmPurchase).toHaveBeenCalledTimes(2));
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(1, "one-time-hosted-order-1");
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(2, "one-time-hosted-order-1");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the paywall locked while a saved-card purchase is pending", async () => {
    mocks.startPurchase.mockResolvedValue({ kind: "pending" });
    const onUnlock = vi.fn();

    render(
      <PaywallSheet
        onClose={vi.fn()}
        onUnlock={onUnlock}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    expect(await screen.findByRole("status")).toHaveTextContent("pendingActivation");
    expect(onUnlock).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    await waitFor(() => expect(mocks.startPurchase).toHaveBeenCalledTimes(2));
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("retries a known saved-card upsell order by confirming that exact id", async () => {
    mocks.startPurchase.mockResolvedValue({
      kind: "pending",
      orderId: "upsell-saved-order-1",
    });
    mocks.confirmPurchase
      .mockResolvedValueOnce({ kind: "pending", orderId: "upsell-saved-order-1" })
      .mockResolvedValueOnce({ kind: "granted" });
    const onUnlock = vi.fn();

    render(
      <PaywallSheet
        onClose={vi.fn()}
        onUnlock={onUnlock}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    expect(await screen.findByRole("status")).toHaveTextContent("pendingActivation");

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    await waitFor(() => expect(mocks.confirmPurchase).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenLastCalledWith("upsell-saved-order-1");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(1);
    expect(onUnlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(2, "upsell-saved-order-1");
    expect(mocks.startPurchase).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-confirms the same hosted upsell order and unlocks only after grant", async () => {
    mocks.startPurchase.mockResolvedValue({
      kind: "needs_card",
      merchantData: { merchant: "data" },
      orderId: "upsell-order-1",
    });
    mocks.confirmPurchase
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValueOnce({ kind: "granted" });
    const onUnlock = vi.fn();

    render(
      <PaywallSheet
        onClose={vi.fn()}
        onUnlock={onUnlock}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    fireEvent.click(await screen.findByRole("button", { name: "hosted-success" }));

    expect(await screen.findByRole("status")).toHaveTextContent("pendingActivation");
    expect(onUnlock).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "subscribeCta" }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(1, "upsell-order-1");
    expect(mocks.confirmPurchase).toHaveBeenNthCalledWith(2, "upsell-order-1");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
