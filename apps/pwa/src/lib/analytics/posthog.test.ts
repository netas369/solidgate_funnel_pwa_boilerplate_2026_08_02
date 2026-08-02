import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  optIn: vi.fn(),
  hasOptedOut: vi.fn(() => false),
  capture: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: mocks.init,
    identify: mocks.identify,
    register: mocks.register,
    opt_in_capturing: mocks.optIn,
    has_opted_out_capturing: mocks.hasOptedOut,
    capture: mocks.capture,
    reset: mocks.reset,
  },
}));

describe("PWA PostHog configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.hasOptedOut.mockReturnValue(false);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
  });

  it("initializes once in the authenticated area without PII or passive capture", async () => {
    const { initializePwaAnalytics } = await import("./posthog");
    expect(initializePwaAnalytics("opaque-user-uuid", "lt")).toBe(true);
    expect(initializePwaAnalytics("opaque-user-uuid", "lt")).toBe(true);

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.init).toHaveBeenCalledWith("phc_test", expect.objectContaining({
      api_host: "https://eu.i.posthog.com",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      capture_exceptions: false,
      person_profiles: "identified_only",
    }));
    // Capturing is on by default; no opt-in event should be emitted.
    expect(mocks.optIn).not.toHaveBeenCalled();
    expect(mocks.identify).toHaveBeenCalledWith("opaque-user-uuid");
    expect(mocks.identify.mock.calls.flat()).not.toContain("email");
    expect(mocks.register).toHaveBeenCalledWith({ app: "pwa", locale: "lt" });
  });

  it("flips a legacy banner opt-out back to opted-in without an $opt_in event", async () => {
    mocks.hasOptedOut.mockReturnValue(true);
    const { initializePwaAnalytics } = await import("./posthog");
    initializePwaAnalytics("opaque-user-uuid", "lt");

    expect(mocks.optIn).toHaveBeenCalledOnce();
    expect(mocks.optIn).toHaveBeenCalledWith({ captureEventName: null });
  });

  it("registers inherited first-touch acquisition on authenticated PWA events", async () => {
    const { initializePwaAnalytics } = await import("./posthog");
    initializePwaAnalytics("opaque-user-uuid", "lt", {
      utm_source: "fb",
      utm_campaign: "Creative Testing",
    });

    expect(mocks.register).toHaveBeenCalledWith({
      app: "pwa",
      locale: "lt",
      utm_source: "fb",
      first_touch_utm_source: "fb",
      utm_campaign: "Creative Testing",
      first_touch_utm_campaign: "Creative Testing",
    });
  });

  it("captures a pathname-only pageview once initialized", async () => {
    const { initializePwaAnalytics, capturePwaPageView } = await import("./posthog");
    initializePwaAnalytics("opaque-user-uuid", "en");
    capturePwaPageView("/en/dashboard", "en");

    expect(mocks.capture).toHaveBeenCalledWith("$pageview", {
      $current_url: "/en/dashboard",
      app: "pwa",
      locale: "en",
    });
  });

  it("resets the identified person on logout so a shared device cannot merge accounts", async () => {
    const { initializePwaAnalytics, resetPwaAnalytics } = await import("./posthog");
    initializePwaAnalytics("first-user", "en");
    resetPwaAnalytics();
    initializePwaAnalytics("second-user", "en");

    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.identify).toHaveBeenNthCalledWith(1, "first-user");
    expect(mocks.identify).toHaveBeenNthCalledWith(2, "second-user");
  });
});
