import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseOutcome } from "@/lib/solidgate/checkout";

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const refresh = vi.fn();
  return {
    pathname: "/en/dashboard",
    query: "",
    replace,
    refresh,
    router: { replace, refresh },
    confirmPurchaseAfterRedirect: vi.fn(),
  };
});

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => mocks.router,
}));

vi.mock("@/lib/solidgate/checkout", () => ({
  confirmPurchaseAfterRedirect: mocks.confirmPurchaseAfterRedirect,
}));

import {
  PWA_RETURN_MAX_AUTO_AGE_MS,
  PWA_RETURN_MAX_AUTO_CYCLES,
  PWA_RETURN_RETRY_DELAY_MS,
  SolidgatePurchaseReturn,
} from "./SolidgatePurchaseReturn";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

describe("SolidgatePurchaseReturn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/en/dashboard";
    mocks.query = "tab=library&sg_confirm=pwa-order-1&source=3ds";
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps one deferred recovery alive through StrictMode and retains a pending URL", async () => {
    const confirmation = deferred<PurchaseOutcome>();
    mocks.confirmPurchaseAfterRedirect.mockReturnValue(confirmation.promise);

    const view = render(
      <React.StrictMode>
        <SolidgatePurchaseReturn />
      </React.StrictMode>,
    );

    expect(mocks.confirmPurchaseAfterRedirect).toHaveBeenCalledOnce();
    expect(mocks.confirmPurchaseAfterRedirect).toHaveBeenCalledWith(
      "pwa-order-1",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(screen.getByRole("status"))
      .toHaveAttribute("data-payment-recovery-state", "processing");
    expect(screen.getByRole("status")).toHaveTextContent("completingVerification");

    // A new ReadonlyURLSearchParams identity with the same serialized query
    // must not start a second provider recovery.
    view.rerender(
      <React.StrictMode>
        <SolidgatePurchaseReturn />
      </React.StrictMode>,
    );
    expect(mocks.confirmPurchaseAfterRedirect).toHaveBeenCalledOnce();

    await act(async () => {
      confirmation.resolve({ kind: "pending", orderId: "pwa-order-1" });
      await confirmation.promise;
    });

    expect(screen.getByRole("status"))
      .toHaveAttribute("data-payment-recovery-state", "pending");
    expect(screen.getByRole("status")).toHaveTextContent("processing");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.query).toContain("sg_confirm=pwa-order-1");
  });

  it("removes only sg_confirm and hides the banner after a terminal result", async () => {
    const confirmation = deferred<PurchaseOutcome>();
    mocks.confirmPurchaseAfterRedirect.mockReturnValue(confirmation.promise);
    render(<SolidgatePurchaseReturn />);

    expect(screen.getByRole("status")).toBeVisible();
    await act(async () => {
      confirmation.resolve({
        kind: "failed",
        error: "Payment not completed",
        status: "declined",
        httpStatus: 402,
        orderId: "pwa-order-1",
      });
      await confirmation.promise;
    });

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      "/en/dashboard?tab=library&source=3ds",
      { scroll: false },
    ));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("slowly retries the same pending order without consuming its URL", async () => {
    vi.useFakeTimers();
    try {
      mocks.confirmPurchaseAfterRedirect
        .mockResolvedValueOnce({ kind: "pending", orderId: "pwa-order-1" })
        .mockReturnValueOnce(new Promise(() => {}));

      render(<SolidgatePurchaseReturn />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByRole("status"))
        .toHaveAttribute("data-payment-recovery-state", "pending");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PWA_RETURN_RETRY_DELAY_MS);
      });

      expect(mocks.confirmPurchaseAfterRedirect).toHaveBeenCalledTimes(2);
      expect(mocks.confirmPurchaseAfterRedirect.mock.calls[0]?.[0]).toBe("pwa-order-1");
      expect(mocks.confirmPurchaseAfterRedirect.mock.calls[1]?.[0]).toBe("pwa-order-1");
      expect(mocks.replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops automatic provider polling after the shared cycle cap and leaves manual recovery intact", async () => {
    vi.useFakeTimers();
    try {
      mocks.confirmPurchaseAfterRedirect.mockResolvedValue({
        kind: "pending",
        orderId: "pwa-order-1",
      });

      const view = render(<SolidgatePurchaseReturn />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let cycle = 1; cycle < PWA_RETURN_MAX_AUTO_CYCLES; cycle += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PWA_RETURN_RETRY_DELAY_MS);
        });
      }

      expect(mocks.confirmPurchaseAfterRedirect)
        .toHaveBeenCalledTimes(PWA_RETURN_MAX_AUTO_CYCLES);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PWA_RETURN_MAX_AUTO_AGE_MS * 2);
      });
      expect(mocks.confirmPurchaseAfterRedirect)
        .toHaveBeenCalledTimes(PWA_RETURN_MAX_AUTO_CYCLES);
      expect(screen.getByRole("status"))
        .toHaveAttribute("data-payment-recovery-state", "pending");
      expect(mocks.query).toContain("sg_confirm=pwa-order-1");
      expect(mocks.replace).not.toHaveBeenCalled();

      // A real manual refresh remounts the component and can start one new,
      // independently bounded exact-order recovery budget.
      view.unmount();
      render(<SolidgatePurchaseReturn />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.confirmPurchaseAfterRedirect)
        .toHaveBeenCalledTimes(PWA_RETURN_MAX_AUTO_CYCLES + 1);
      expect(mocks.confirmPurchaseAfterRedirect.mock.calls.at(-1)?.[0])
        .toBe("pwa-order-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the shared wall-clock age cannot fit another retry delay", async () => {
    vi.useFakeTimers();
    try {
      const confirmation = deferred<PurchaseOutcome>();
      mocks.confirmPurchaseAfterRedirect.mockReturnValue(confirmation.promise);
      render(<SolidgatePurchaseReturn />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          PWA_RETURN_MAX_AUTO_AGE_MS - PWA_RETURN_RETRY_DELAY_MS + 1,
        );
        confirmation.resolve({ kind: "pending", orderId: "pwa-order-1" });
        await confirmation.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PWA_RETURN_MAX_AUTO_AGE_MS * 2);
      });

      expect(mocks.confirmPurchaseAfterRedirect).toHaveBeenCalledOnce();
      expect(screen.getByRole("status"))
        .toHaveAttribute("data-payment-recovery-state", "pending");
      expect(mocks.query).toContain("sg_confirm=pwa-order-1");
      expect(mocks.replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes sg_confirm and refreshes access after a grant", async () => {
    mocks.query = "sg_confirm=pwa-order-1";
    mocks.confirmPurchaseAfterRedirect.mockResolvedValue({ kind: "granted" });

    render(<SolidgatePurchaseReturn />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(
      "/en/dashboard",
      { scroll: false },
    ));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
