/**
 * Human names for the CRO dashboard's filter buttons.
 *
 * ── THIS IS A PER-PRODUCT EXTENSION POINT ───────────────────────────────────
 * A new product edits the two registries below. Everything else in the CRO
 * pipeline is generated from the quiz config; these are the only display names
 * a human has to write.
 *
 * Without them the dashboard's pickers render raw ids — `main-v1`,
 * `boilerplate-v1` — which are clickable but tell a reader nothing about what
 * changed between two versions.
 *
 * WHY THESE ARE NOT IN THE CATALOG. quiz_definitions is deliberately immutable:
 * step labels must keep describing the questions exactly as they were asked.
 * A picker's display name is not data meaning — it is a caption — so freezing
 * it would mean a typo could only be fixed by bumping QUIZ_VARIANT and
 * republishing. Resolved at request time instead, so correcting one is a
 * deploy.
 *
 * KEEP RETIRED VERSIONS LISTED. Sessions recorded under an old quiz_variant
 * still appear in historical windows, and the picker should name them rather
 * than falling back to the id. Removing an entry is not an error — the id is
 * shown instead — it just makes an old window harder to read.
 */

import { FUNNEL_VARIANT, QUIZ_VARIANT } from "@/features/quiz/server/quiz-definition";

export interface SegmentLabel {
  id: string;
  label: string;
  /**
   * What changed, for versions. This is the field that makes a comparison
   * months later intelligible — "v2 vs v3" means nothing on its own.
   */
  note?: string;
}

/** Acquisition angles. One entry unless the product runs several funnels. */
export const FUNNEL_LABELS: readonly SegmentLabel[] = [
  { id: FUNNEL_VARIANT, label: "Main funnel" },
];

/** Quiz versions, newest last. Add an entry every time QUIZ_VARIANT is bumped. */
export const VERSION_LABELS: readonly SegmentLabel[] = [
  {
    id: QUIZ_VARIANT,
    label: "Boilerplate v1",
    note: "The neutral placeholder quiz that ships with the template.",
  },
];

/**
 * Locales need no registry: Intl already knows every language's name, and a
 * hand-maintained list of 15 would only drift.
 */
function localeLabel(id: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(id) ?? id;
  } catch {
    return id;
  }
}

export type SegmentKind = "funnel" | "version" | "locale";

/** Falls back to the raw id, which is always better than an empty button. */
export function segmentLabel(kind: SegmentKind, id: string): { label: string; note?: string } {
  if (kind === "locale") return { label: localeLabel(id) };
  const registry = kind === "funnel" ? FUNNEL_LABELS : VERSION_LABELS;
  const found = registry.find((entry) => entry.id === id);
  if (!found) return { label: id };
  return found.note === undefined ? { label: found.label } : { label: found.label, note: found.note };
}
