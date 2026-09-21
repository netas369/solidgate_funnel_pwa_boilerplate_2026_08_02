import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the ONE hand-verified property of the generated database types.
 *
 * `supabase gen types` from CLI 2.117.0 declares a function argument without a
 * SQL DEFAULT as non-nullable — `p_step_number: number`. That is wrong: every
 * Postgres argument is nullable, and the routes below pass null on purpose
 * (an event that belongs to no step, a save that changes no locale). An
 * older CLI produced `number | null`, which is what the committed file holds.
 *
 * So a regeneration can QUIETLY LOSE information rather than gain precision.
 * When it does, apps/funnel stops compiling and the cause looks like an app
 * bug rather than a toolchain difference. This test names the cause.
 *
 * If it fails after you regenerate: your CLI has the narrowing behaviour.
 * Re-add `| null` to the arguments listed here, or regenerate with a toolchain
 * that gets it right — do not "fix" the call sites to stop passing null.
 */
const TYPES_PATH = join(import.meta.dirname, "../types/database.ts");

/** Argument → a call site that passes null to it. */
const NULLABLE_ARGS: Record<string, string> = {
  p_step_number: "apps/funnel/src/app/api/funnel-events/route.ts",
  p_occurred_at: "apps/funnel/src/app/api/funnel-events/route.ts",
  p_current_step_id: "apps/funnel/src/app/api/quiz/session/save/route.ts",
  p_consent_given_at: "apps/funnel/src/app/api/quiz/session/save/route.ts",
  p_marketing_consent: "apps/funnel/src/app/api/quiz/session/save/route.ts",
  p_event_step_number: "apps/funnel/src/app/api/quiz/session/save/route.ts",
};

describe("generated database types", () => {
  const source = readFileSync(TYPES_PATH, "utf8");

  it.each(Object.entries(NULLABLE_ARGS))(
    "declares %s nullable, because %s passes null to it",
    (arg, callSite) => {
      // Every declaration of the argument, across whichever functions take it.
      const declarations = [
        ...source.matchAll(new RegExp(`^\\s*${arg}\\??:\\s*(.+)$`, "gm")),
      ].map((m) => m[1]!.trim());

      expect(declarations.length).toBeGreaterThan(0);
      for (const declared of declarations) {
        expect(
          declared.includes("null"),
          `${arg} is typed \`${declared}\`, but ${callSite} passes null. ` +
            "A regeneration has narrowed it — see this file's header.",
        ).toBe(true);
      }
    },
  );

  it("keeps the columns the CRO board reads", () => {
    // Cheap canary for a regeneration run against a stale schema: these two
    // were added with the Answers tab and are the newest things in the file.
    expect(source).toContain("option_labels");
    expect(source).toContain("answer_label");
  });
});
