import { describe, expect, it } from "vitest";
import { FUNNEL_VARIANT, QUIZ_VARIANT } from "../../quiz-variant";
import { segmentLabel, VERSION_LABELS } from "../../cro/segment-labels";

describe("segmentLabel", () => {
  it("names the shipped funnel and quiz version", () => {
    expect(segmentLabel("funnel", FUNNEL_VARIANT).label).toBe("Main funnel");
    expect(segmentLabel("version", QUIZ_VARIANT).label).toBe("Boilerplate v1");
  });

  it("carries the version note — 'v2 vs v3' means nothing on its own", () => {
    expect(segmentLabel("version", QUIZ_VARIANT).note).toBeTruthy();
  });

  it("resolves locales through Intl rather than a hand-kept list", () => {
    expect(segmentLabel("locale", "en").label).toBe("English");
    expect(segmentLabel("locale", "lt").label).toBe("Lithuanian");
  });

  it("falls back to the raw id, never an empty button", () => {
    expect(segmentLabel("version", "never-registered-v9")).toEqual({
      label: "never-registered-v9",
    });
    expect(segmentLabel("funnel", "unknown-v2").label).toBe("unknown-v2");
    expect(segmentLabel("locale", "zz").label).toBe("zz");
  });

  it("registers the version this deployment actually writes", () => {
    // A bumped QUIZ_VARIANT with no registry entry makes every historical
    // window read as a raw id.
    expect(VERSION_LABELS.some((entry) => entry.id === QUIZ_VARIANT)).toBe(true);
  });
});
