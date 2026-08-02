import { describe, expect, it } from "vitest";
import { acquisitionEventProperties, normalizeAcquisitionUtm } from "./acquisition";

describe("account acquisition attribution", () => {
  it("keeps only canonical non-empty UTMs within Solidgate's field limit", () => {
    expect(normalizeAcquisitionUtm({
      utm_source: " fb ",
      utm_campaign: ` ${"x".repeat(500)} `,
      utm_term: "",
      fbclid: "drop-me",
    })).toEqual({
      utm_source: "fb",
      utm_campaign: "x".repeat(380),
    });
  });

  it("registers first-touch aliases for authenticated PWA events", () => {
    expect(acquisitionEventProperties({ utm_source: "fb", utm_medium: "feed" })).toEqual({
      utm_source: "fb",
      first_touch_utm_source: "fb",
      utm_medium: "feed",
      first_touch_utm_medium: "feed",
    });
  });
});
