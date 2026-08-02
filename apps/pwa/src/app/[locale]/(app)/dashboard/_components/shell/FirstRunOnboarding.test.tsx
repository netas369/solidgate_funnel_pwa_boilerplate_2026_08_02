import * as React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FirstRunOnboarding,
  ONBOARDING_STORAGE_KEY,
} from "./FirstRunOnboarding";

vi.mock("next-intl", () => {
  const messages: Record<string, string> = {
    "pwa.onboarding.dialogLabel": "A guide to the member area",
    "pwa.onboarding.skip": "Skip",
    "pwa.onboarding.close": "Close",
    "pwa.onboarding.back": "Back",
    "pwa.onboarding.next": "Next",
    "pwa.onboarding.finish": "Get started",
    "pwa.onboarding.progress": "Step {current} of {total}",
    "pwa.onboarding.statusPreparing": "Preparing your account",
    "pwa.onboarding.statusReady": "Your account is ready",
    "pwa.onboarding.steps.welcome.kicker": "Welcome kicker",
    "pwa.onboarding.steps.welcome.title": "Welcome headline goes here",
    "pwa.onboarding.steps.welcome.body": "Welcome body.",
    "pwa.onboarding.steps.explore.kicker": "Three places to return to",
    "pwa.onboarding.steps.explore.title": "Explore headline goes here",
    "pwa.onboarding.steps.explore.body": "Explore body.",
    "pwa.onboarding.steps.learn.kicker": "Read at your pace",
    "pwa.onboarding.steps.learn.title": "Learn headline goes here",
    "pwa.onboarding.steps.learn.body": "Learn body.",
    "pwa.onboarding.steps.preparing.kicker": "A note about preparation",
    "pwa.onboarding.steps.preparing.title": "Preparing headline goes here",
    "pwa.onboarding.steps.preparing.body": "Preparing body.",
    "pwa.onboarding.steps.preparing.keepBrowsing": "Keep browsing.",
    "pwa.topnav.brand": "Acme",
    "pwa.nav.home": "Home",
    "pwa.nav.library": "Library",
    "pwa.nav.profile": "Profile",
  };

  for (const id of ["home", "library", "profile"]) {
    messages[`pwa.onboarding.steps.explore.items.${id}`] = `${id} description`;
  }

  return {
    useTranslations:
      (namespace: string) =>
      (key: string, values?: Record<string, string | number>) => {
        let message = messages[`${namespace}.${key}`] ?? `${namespace}.${key}`;
        for (const [name, value] of Object.entries(values ?? {})) {
          message = message.replace(`{${name}}`, String(value));
        }
        return message;
      },
  };
});

function renderOnboarding({
  mode = "auto",
  ready = false,
  onClose = vi.fn(),
}: {
  mode?: "auto" | "replay";
  ready?: boolean;
  onClose?: () => void;
} = {}) {
  render(<FirstRunOnboarding mode={mode} ready={ready} onClose={onClose} />);
  return { onClose };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("FirstRunOnboarding", () => {
  it("shows the localized dialog when onboarding has not been completed", async () => {
    renderOnboarding();

    expect(
      await screen.findByRole("dialog", { name: "Welcome headline goes here" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Welcome headline goes here" }),
    ).toHaveFocus();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
  });

  it("closes without showing the dialog when completion is already stored", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    const onClose = vi.fn();
    renderOnboarding({ onClose });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves through all four steps and persists completion on the final action", async () => {
    const onClose = vi.fn();
    renderOnboarding({ onClose });
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Explore headline goes here" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Learn headline goes here" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByRole("heading", { name: "Preparing headline goes here" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("persists completion when the tour is skipped", async () => {
    const onClose = vi.fn();
    renderOnboarding({ onClose });
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("always opens in replay mode and labels the dismiss action as Close", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    const onClose = vi.fn();
    renderOnboarding({ mode: "replay", onClose });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses and persists completion with Escape", async () => {
    const onClose = vi.fn();
    renderOnboarding({ onClose });
    await screen.findByRole("dialog");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("true");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus inside the dialog when tabbing backwards from the title", async () => {
    renderOnboarding();
    await screen.findByRole("dialog");
    const title = screen.getByRole("heading", {
      name: "Welcome headline goes here",
    });
    const next = screen.getByRole("button", { name: "Next" });
    expect(title).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });

    expect(next).toHaveFocus();
  });

  it("returns focus to the menu trigger after replaying from the closed drawer", async () => {
    function ReplayHarness() {
      const menuButtonRef = React.useRef<HTMLButtonElement>(null);
      const replayButtonRef = React.useRef<HTMLButtonElement>(null);

      React.useLayoutEffect(() => {
        replayButtonRef.current?.focus();
      }, []);

      return (
        <>
          <button ref={menuButtonRef}>Open menu</button>
          <div aria-hidden="true" inert>
            <button ref={replayButtonRef}>Replay onboarding</button>
          </div>
          <FirstRunOnboarding
            mode="replay"
            ready={false}
            returnFocusRef={menuButtonRef}
            onClose={vi.fn()}
          />
        </>
      );
    }

    render(<ReplayHarness />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open menu" })).toHaveFocus(),
    );
  });

  it("still shows and closes safely when localStorage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const onClose = vi.fn();
    renderOnboarding({ onClose });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("announces when preparation is already complete", async () => {
    renderOnboarding({ mode: "replay", ready: true });

    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("status")).toHaveTextContent("Your account is ready");
  });
});
