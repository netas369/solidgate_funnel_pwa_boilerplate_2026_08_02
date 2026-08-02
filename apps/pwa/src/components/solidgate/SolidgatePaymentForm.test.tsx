import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  load: vi.fn(),
  props: null as Record<string, unknown> | null,
}));

vi.mock("@solidgate/react-sdk", () => ({
  default: (props: Record<string, unknown>) => {
    sdk.props = props;
    return <div data-testid="solidgate-sdk" />;
  },
  SdkLoader: { load: sdk.load },
}));

import type { MerchantData } from "@/lib/solidgate/checkout";
import { SolidgatePaymentForm } from "./SolidgatePaymentForm";

const merchantData: MerchantData = {
  merchant: "merchant",
  paymentIntent: "payment-intent-1",
  signature: "signature-1",
};

function sdkEvent(name: "onSubmit" | "onSuccess" | "onFail" | "onError") {
  const callback = sdk.props?.[name];
  if (typeof callback !== "function") throw new Error(`Missing SDK callback: ${name}`);
  return callback as (event?: unknown) => void;
}

function renderForm(orderId: string, onPaid = vi.fn(), onFail = vi.fn()) {
  const view = render(
    <SolidgatePaymentForm
      merchantData={merchantData}
      orderId={orderId}
      buttonText="Pay"
      onPaid={onPaid}
      onFail={onFail}
    />,
  );
  return { ...view, onPaid, onFail };
}

describe("SolidgatePaymentForm submission latch", () => {
  beforeEach(() => {
    sdk.props = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps wallets disabled unless the purchase flow opts in", () => {
    renderForm("hosted-order-1");

    expect(sdk.props?.applePayButtonParams).toEqual({ enabled: false });
    expect(sdk.props?.googlePayButtonParams).toEqual({ enabled: false });
  });

  it("enables Apple Pay with the cross-browser JS integration for purchase forms", () => {
    render(
      <SolidgatePaymentForm
        merchantData={merchantData}
        orderId="hosted-order-wallet"
        buttonText="Pay"
        enableApplePay
        onPaid={vi.fn()}
        onFail={vi.fn()}
      />,
    );

    expect(sdk.props?.applePayButtonParams).toEqual({
      enabled: true,
      integrationType: "js",
    });
    expect(sdk.props?.googlePayButtonParams).toEqual({ enabled: false });
  });

  it("shows the saved-method authorization disclosure beside an enabled wallet form", () => {
    const disclosure = "Stored securely; charged only when you select a purchase.";
    render(
      <SolidgatePaymentForm
        merchantData={merchantData}
        orderId="hosted-order-wallet-disclosure"
        buttonText="Pay"
        enableApplePay
        savedMethodDisclosure={disclosure}
        onPaid={vi.fn()}
        onFail={vi.fn()}
      />,
    );

    expect(screen.getByText(disclosure)).toBeVisible();
  });

  it.each(["onSuccess", "onFail", "onError"] as const)(
    "confirms the submitted order once when the SDK emits %s",
    async (terminalEvent) => {
      const { container, onPaid, onFail } = renderForm("hosted-order-1");

      await act(async () => {
        sdkEvent("onSubmit")({});
        sdkEvent(terminalEvent)({ message: "provider-message", code: "provider-code" });
      });

      expect(onPaid).toHaveBeenCalledOnce();
      expect(onPaid).toHaveBeenCalledWith("hosted-order-1");
      expect(onFail).not.toHaveBeenCalled();
      expect(container.firstElementChild).toHaveAttribute("inert");
      expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");

      await act(async () => {
        sdkEvent("onSuccess")({});
        sdkEvent("onFail")({ message: "late failure" });
        sdkEvent("onError")({});
      });
      expect(onPaid).toHaveBeenCalledOnce();
      expect(onFail).not.toHaveBeenCalled();
    },
  );

  it("reports fail and error events that occur before submission", async () => {
    const { container, onPaid, onFail } = renderForm("hosted-order-1");

    await act(async () => {
      sdkEvent("onFail")({ message: "Card details are incomplete" });
      sdkEvent("onError")({});
    });

    expect(onPaid).not.toHaveBeenCalled();
    expect(onFail).toHaveBeenNthCalledWith(1, "Card details are incomplete");
    expect(onFail).toHaveBeenNthCalledWith(2, "payment_error");
    expect(container.firstElementChild).not.toHaveAttribute("inert");
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");
  });

  it("retains the latch for the same order and resets it only for a different order", async () => {
    const firstPaid = vi.fn();
    const secondPaid = vi.fn();
    const onFail = vi.fn();
    const { container, rerender } = renderForm("hosted-order-1", firstPaid, onFail);

    await act(async () => {
      sdkEvent("onSubmit")({});
      sdkEvent("onFail")({ message: "ambiguous post-submit failure" });
    });
    expect(firstPaid).toHaveBeenCalledOnce();
    expect(container.firstElementChild).toHaveAttribute("inert");

    rerender(
      <SolidgatePaymentForm
        merchantData={{ ...merchantData, paymentIntent: "refreshed-same-order-intent" }}
        orderId="hosted-order-1"
        buttonText="Pay again"
        onPaid={firstPaid}
        onFail={onFail}
      />,
    );
    await act(async () => sdkEvent("onSuccess")({}));
    expect(firstPaid).toHaveBeenCalledOnce();
    expect(container.firstElementChild).toHaveAttribute("inert");

    rerender(
      <SolidgatePaymentForm
        merchantData={{ ...merchantData, paymentIntent: "payment-intent-2" }}
        orderId="hosted-order-2"
        buttonText="Pay"
        onPaid={secondPaid}
        onFail={onFail}
      />,
    );
    expect(container.firstElementChild).not.toHaveAttribute("inert");
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      sdkEvent("onSubmit")({});
      sdkEvent("onError")({});
    });
    expect(secondPaid).toHaveBeenCalledOnce();
    expect(secondPaid).toHaveBeenCalledWith("hosted-order-2");
    expect(onFail).not.toHaveBeenCalled();
  });
});
