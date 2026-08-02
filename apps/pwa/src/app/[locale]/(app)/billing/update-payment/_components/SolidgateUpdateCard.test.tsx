import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returnOrderId: null as string | null,
  replace: vi.fn(),
  paymentFormProps: null as Record<string, unknown> | null,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => key === "sg_card_update" ? mocks.returnOrderId : null,
  }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "cs",
  useTranslations: () => (key: string) => key,
}));

vi.mock("@repo/i18n/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/components/solidgate/SolidgatePaymentForm", () => ({
  SolidgatePaymentForm: (props: Record<string, unknown>) => {
    mocks.paymentFormProps = props;
    return <div data-testid="payment-form" />;
  },
}));

import { SolidgateUpdateCard } from "./SolidgateUpdateCard";

describe("SolidgateUpdateCard 3DS return", () => {
  beforeEach(() => {
    mocks.returnOrderId = null;
    mocks.paymentFormProps = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens a localized zero-auth form when there is no return marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        merchantData: { merchant: "m", paymentIntent: "p", signature: "s" },
        orderId: "card-update-order-1",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SolidgateUpdateCard productName="Main plan" />);

    expect(await screen.findByTestId("payment-form")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ locale: "cs" });
    expect(mocks.paymentFormProps).toMatchObject({ orderId: "card-update-order-1" });
  });

  it("confirms one exact returned order once under StrictMode and then leaves the page", async () => {
    mocks.returnOrderId = "card-update-order-return";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <React.StrictMode>
        <SolidgateUpdateCard productName="Main plan" />
      </React.StrictMode>,
    );

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/dashboard?payment_updated=1");
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ orderId: "card-update-order-return" });
    expect(screen.queryByTestId("payment-form")).not.toBeInTheDocument();
  });

  it("retries the exact return order while provider confirmation is not final", async () => {
    mocks.returnOrderId = "card-update-order-pending";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 202,
        json: async () => ({ pending: true, retryAfterMs: 250 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<SolidgateUpdateCard productName="Main plan" />);

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/dashboard?payment_updated=1");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("payment-form")).not.toBeInTheDocument();
  });

  it("keeps a terminal exact return on the recovery page without opening another form", async () => {
    mocks.returnOrderId = "card-update-order-terminal";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ terminal: true }),
    }));

    render(<SolidgateUpdateCard productName="Main plan" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("updateError");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("payment-form")).not.toBeInTheDocument();
  });
});
