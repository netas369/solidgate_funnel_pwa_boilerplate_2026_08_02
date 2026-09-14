import { describe, expect, it } from "vitest";
import {
  assembleFunnelResponse,
  dropSeverity,
  type CroStepFunnelRow,
} from "../../cro/funnel-response";

function row(over: Partial<CroStepFunnelRow> & { step_id: string }): CroStepFunnelRow {
  return {
    quiz_variant: "v1",
    funnel_variant: "main-v1",
    step_position: 1,
    sort_index: 1,
    step_type: "radio",
    phase_key: "phases.start",
    label: `Label for ${over.step_id}`,
    is_question: true,
    is_terminal: false,
    is_unconditional: true,
    entry_skippable: false,
    in_catalog: true,
    has_traffic: true,
    position_cohort: 0,
    viewed: 0,
    answered: 0,
    skipped: 0,
    advanced: 0,
    dropped: 0,
    unsettled: 0,
    total_views: 0,
    revisits: 0,
    p50_seconds_to_answer: null,
    p90_seconds_to_answer: null,
    ...over,
  };
}

const OPTIONS = {
  appKey: "acme",
  appLabel: "Acme",
  capabilities: ["overview", "dropoff"],
  quizVariant: "v1",
  configHash: "a".repeat(64),
  firstStepId: "step1",
  totalSteps: 4,
  terminalStepIds: ["step4"],
  range: { from: "2026-09-01T00:00:00Z", to: "2026-09-08T00:00:00Z" },
  segments: {
    funnels: [{ id: "main-v1", label: "Main funnel", sessions: 100 }],
    versions: [{ id: "v1", label: "Version 1", note: "First cut", sessions: 100 }],
    locales: [{ id: "en", label: "English", sessions: 100 }],
    selected: { funnel: null, version: "v1", locale: null },
  },
  generatedAt: "2026-09-11T09:00:00Z",
};

/**
 * step1 -> step2 -> (step3 | step3b, both position 3) -> step4 (terminal).
 * step3c is a COMPANION at position 3: everyone who lands there sees it.
 */
function baseRows(): CroStepFunnelRow[] {
  return [
    row({ step_id: "step1", step_position: 1, sort_index: 1, viewed: 1000, answered: 900, dropped: 100 }),
    row({ step_id: "step2", step_position: 2, sort_index: 2, viewed: 900, answered: 800, dropped: 100 }),
    row({ step_id: "step3", step_position: 3, sort_index: 3, viewed: 600, answered: 560, dropped: 40 }),
    row({ step_id: "step3c", step_position: 3, sort_index: 4, viewed: 560, answered: 550, dropped: 10 }),
    row({
      step_id: "step3b", step_position: 3, sort_index: 5, is_unconditional: false,
      viewed: 300, answered: 200, dropped: 100,
    }),
    row({
      step_id: "step4", step_position: 4, sort_index: 6, is_terminal: true,
      is_question: false, viewed: 700, answered: 0, dropped: 0,
    }),
  ];
}

describe("assembleFunnelResponse — positions and arms", () => {
  it("picks the lead by declaration order, not alphabetically", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    expect(out.steps.find((s) => s.position === 3)?.lead.stepId).toBe("step3");
  });

  it("splits companions from branches on isUnconditional, not shared position", () => {
    const group = assembleFunnelResponse(baseRows(), OPTIONS).steps.find((s) => s.position === 3)!;
    // All three sit at position 3. Only step3b is conditional.
    expect(group.companions.map((c) => c.stepId)).toEqual(["step3c"]);
    expect(group.branches.map((b) => b.stepId)).toEqual(["step3b"]);
  });

  it("tags arms so the dashboard need not re-derive the wording", () => {
    const group = assembleFunnelResponse(baseRows(), OPTIONS).steps.find((s) => s.position === 3)!;
    expect(group.companions[0].tag).toBe("Everyone sees this");
    expect(group.branches[0].tag).toBe("Only some visitors");
    expect(group.lead.tag).toBeNull();
  });

  it("measures an arm's share against its SLOT, never funnel entry", () => {
    const group = assembleFunnelResponse(baseRows(), OPTIONS).steps.find((s) => s.position === 3)!;
    // 300 of the 600 who reached position 3 — not 300 of the 1000 who entered,
    // which would read as a 70% cliff.
    expect(group.branches[0].shareOfSlotPct).toBe(50);
  });

  it("takes reached from the lead alone", () => {
    const group = assembleFunnelResponse(baseRows(), OPTIONS).steps.find((s) => s.position === 3)!;
    // Not the sum (double-counts the companion) and not the max.
    expect(group.reached).toBe(600);
  });
});

describe("assembleFunnelResponse — how much traffic a POSITION saw", () => {
  /**
   * step2 forks into two arms that BOTH sit at position 2, and neither is on
   * the spine. Regression: `reached` used to be the lead arm's views alone, so
   * the slot under-reported by everyone who took the other arm and the funnel
   * line CLIMBED at position 3. A funnel that goes up is the one shape it
   * cannot have, and no test caught it — it was found by rendering the board.
   */
  function pureBranch(): CroStepFunnelRow[] {
    return [
      row({ step_id: "step1", step_position: 1, sort_index: 1, viewed: 1000, answered: 900, dropped: 100 }),
      row({
        step_id: "step2a", step_position: 2, sort_index: 2, is_unconditional: false,
        viewed: 600, answered: 560, dropped: 40,
      }),
      row({
        step_id: "step2b", step_position: 2, sort_index: 3, is_unconditional: false,
        viewed: 300, answered: 280, dropped: 20,
      }),
      row({
        step_id: "step3", step_position: 3, sort_index: 4, is_terminal: true,
        viewed: 840, answered: 0,
      }),
    ];
  }

  it("sums the arms when every screen at the position is conditional", () => {
    const view = assembleFunnelResponse(pureBranch(), OPTIONS);
    expect(view.steps[1]!.reached).toBe(900);
  });

  it("never lets the funnel climb", () => {
    const view = assembleFunnelResponse(pureBranch(), OPTIONS);
    const reached = view.steps.filter((s) => !s.retired).map((s) => s.reached);
    for (let i = 1; i < reached.length; i += 1) {
      expect(reached[i]).toBeLessThanOrEqual(reached[i - 1]!);
    }
  });

  it("reports the SLOT's losses beside the slot's traffic", () => {
    // The two have to be measured the same way or the row divides one
    // position's reach by another screen's drop: "461 reached, 33 left (11%)"
    // invites reading 11% of 461, which would be 51 people.
    const view = assembleFunnelResponse(pureBranch(), OPTIONS);
    const branchPosition = view.steps[1]!;
    expect(branchPosition.reached).toBe(900);
    expect(branchPosition.dropped).toBe(60);
    expect(branchPosition.dropPct).toBe(6.7);
    // The arms keep their OWN denominators — an arm's drop is measured against
    // its own views, never the slot's. (The first arm is the row's lead; the
    // rest are branches.)
    expect(branchPosition.lead.dropPct).toBe(6.7);
    expect(branchPosition.branches.map((b) => b.dropPct)).toEqual([6.7]);
  });

  it("does NOT add the arms when a screen everyone sees is present", () => {
    // Adding a conditional arm on top of an unconditional screen would count
    // the same visitor twice: they saw both.
    const view = assembleFunnelResponse(baseRows(), OPTIONS);
    const position3 = view.steps.find((s) => s.position === 3)!;
    expect(position3.reached).toBe(600);
  });

  it("is independent of the order the screens were declared in", () => {
    // Declaration order is a config detail. A slot that reports less traffic
    // than the screen it opens with, because an arm was listed first, is a
    // reporting bug rather than a quiz change.
    const shuffled = baseRows().map((r) =>
      r.step_id === "step3" ? { ...r, sort_index: 9 } : r,
    );
    const view = assembleFunnelResponse(shuffled, OPTIONS);
    expect(view.steps.find((s) => s.position === 3)!.reached).toBe(600);
  });
});

describe("assembleFunnelResponse — totals", () => {
  it("counts entry from the first live position and finish from terminal VIEWS", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    expect(out.totals.entered).toBe(1000);
    // A terminal screen never gets answered — it advances on its own.
    expect(out.totals.finished).toBe(700);
    expect(out.totals.finishPct).toBe(70);
    expect(out.totals.smallSample).toBe(false);
  });

  it("flags a small sample and never divides by zero", () => {
    const out = assembleFunnelResponse(
      [row({ step_id: "step1", viewed: 12, answered: 9, dropped: 3 })],
      OPTIONS,
    );
    expect(out.totals.smallSample).toBe(true);
    expect(out.warnings.map((w) => w.code)).toContain("SMALL_SAMPLE");

    const empty = assembleFunnelResponse([], OPTIONS);
    expect(empty.totals).toMatchObject({ entered: 0, finished: 0, finishPct: 0 });
  });
});

describe("assembleFunnelResponse — severity and highlights", () => {
  it("applies the 25 / 10 thresholds", () => {
    expect(dropSeverity(25)).toBe("heavy");
    expect(dropSeverity(24.9)).toBe("notable");
    expect(dropSeverity(10)).toBe("notable");
    expect(dropSeverity(9.9)).toBe("normal");
  });

  it("names the biggest loss, and says whether it was an extra screen", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    // step3b loses 100 of 300 = 33.3%, the worst on the board.
    expect(out.biggestLoss).toMatchObject({
      stepId: "step3b",
      dropPct: 33.3,
      droppedPeople: 100,
      isLeadOfPosition: false,
      displayIndex: 3,
    });
  });

  it("returns no biggest loss when nothing is worse than normal", () => {
    const gentle = [
      row({ step_id: "step1", step_position: 1, sort_index: 1, viewed: 1000, answered: 990, dropped: 10 }),
    ];
    expect(assembleFunnelResponse(gentle, OPTIONS).biggestLoss).toBeNull();
  });

  it("ranks by people lost rather than percentage on a small sample", () => {
    const rows = [
      row({ step_id: "step1", step_position: 1, sort_index: 1, viewed: 20, answered: 12, dropped: 8 }),
      // Higher percentage, fewer people. On a small sample the bigger absolute
      // loss should win, because a percentage off four sessions is noise.
      row({ step_id: "step2", step_position: 2, sort_index: 2, viewed: 4, answered: 1, dropped: 3 }),
    ];
    expect(assembleFunnelResponse(rows, OPTIONS).biggestLoss?.stepId).toBe("step1");
  });

  it("raises an arm alert only when a collapsed branch is heavy", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    const group = out.steps.find((s) => s.position === 3)!;
    expect(group.worstArmDropPct).toBe(33.3);
    expect(group.armAlertPct).toBe(33.3);
    // A mild branch must not raise one.
    const mild = baseRows().map((r) =>
      r.step_id === "step3b" ? { ...r, answered: 290, dropped: 10 } : r,
    );
    expect(assembleFunnelResponse(mild, OPTIONS).steps.find((s) => s.position === 3)!.armAlertPct)
      .toBeNull();
  });

  it("ignores a thin branch when choosing the worst arm", () => {
    const thin = baseRows().map((r) =>
      r.step_id === "step3b" ? { ...r, viewed: 5, answered: 0, dropped: 5 } : r,
    );
    // 100% drop, but on five people — below the alert floor.
    expect(assembleFunnelResponse(thin, OPTIONS).steps.find((s) => s.position === 3)!.worstArmDropPct)
      .toBe(0);
  });
});

describe("assembleFunnelResponse — rows the dashboard must still see", () => {
  it("keeps a published step nobody reached", () => {
    const rows = [
      ...baseRows(),
      row({ step_id: "step5", step_position: 5, sort_index: 7, has_traffic: false, viewed: 0 }),
    ];
    const out = assembleFunnelResponse(rows, OPTIONS);
    const tail = out.steps.find((s) => s.position === 5)!;
    // Dropping it would make "nobody got this far" and "this step does not
    // exist" render identically.
    expect(tail.hasTraffic).toBe(false);
    expect(tail.reached).toBe(0);
    expect(tail.lead.dropPct).toBe(0);
  });

  it("buckets a step the catalog no longer knows, without a position", () => {
    const rows = [
      ...baseRows(),
      row({ step_id: "ghost", in_catalog: false, step_position: null, sort_index: null, viewed: 9, dropped: 9 }),
    ];
    const out = assembleFunnelResponse(rows, OPTIONS);
    const retired = out.steps.find((s) => s.retired)!;
    expect(retired.position).toBeNull();
    expect(retired.displayIndex).toBeNull();
    expect(retired.reached).toBe(0);
    expect(out.warnings.map((w) => w.code)).toContain("RETIRED_STEPS");
    // A retired step must never be offered as the biggest loss.
    expect(out.biggestLoss?.stepId).not.toBe("ghost");
  });

  it("numbers display indices over live positions only", () => {
    const rows = [
      row({ step_id: "ghost", in_catalog: false, step_position: null, sort_index: null, viewed: 5 }),
      ...baseRows(),
    ];
    const live = assembleFunnelResponse(rows, OPTIONS).steps.filter((s) => !s.retired);
    expect(live.map((s) => s.displayIndex)).toEqual([1, 2, 3, 4]);
  });

  it("reports change against the previous live position", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    expect(out.steps.map((s) => s.changeFromPrev)).toEqual([0, -100, -300, 100]);
  });

  it("warns when the catalog was never published", () => {
    const out = assembleFunnelResponse(baseRows(), { ...OPTIONS, configHash: null });
    expect(out.warnings.map((w) => w.code)).toContain("CATALOG_NOT_PUBLISHED");
  });
});

describe("assembleFunnelResponse — envelope", () => {
  it("carries the contract version, capabilities and segments through", () => {
    const out = assembleFunnelResponse(baseRows(), OPTIONS);
    expect(out.contract).toBe(1);
    expect(out.app.capabilities).toEqual(["overview", "dropoff"]);
    expect(out.segments.versions).toEqual([
      { id: "v1", label: "Version 1", note: "First cut", sessions: 100 },
    ]);
    expect(out.quiz).toMatchObject({ quizVariant: "v1", totalSteps: 4 });
    expect(out.armCount).toBe(1);
  });

  it("converts seconds to milliseconds for the detail cells", () => {
    const rows = [
      row({ step_id: "step1", viewed: 100, answered: 90, dropped: 10,
            p50_seconds_to_answer: 4.5, p90_seconds_to_answer: 19.25 }),
    ];
    const lead = assembleFunnelResponse(rows, OPTIONS).steps[0].lead;
    expect(lead.p50Ms).toBe(4500);
    expect(lead.p90Ms).toBe(19250);
  });
});


describe("assembleFunnelResponse — blended funnel variants", () => {
  it("sums the same step across funnel variants instead of treating it as an extra screen", () => {
    // cro_step_funnel groups by (quiz_variant, funnel_variant, step_id), so an
    // app running an A/B returns step1 once per variant. Bucketing those by
    // position alone would file the second copy as a companion, and step1 would
    // appear as its own extra screen.
    const rows = [
      row({
        step_id: "step1", funnel_variant: "control-v1", step_position: 1, sort_index: 1,
        viewed: 600, answered: 540, dropped: 60,
        p50_seconds_to_answer: 4, p90_seconds_to_answer: 10,
      }),
      row({
        step_id: "step1", funnel_variant: "treatment-v1", step_position: 1, sort_index: 1,
        viewed: 400, answered: 320, dropped: 80,
        p50_seconds_to_answer: 9, p90_seconds_to_answer: 30,
      }),
    ];
    const out = assembleFunnelResponse(rows, OPTIONS);

    expect(out.steps).toHaveLength(1);
    const group = out.steps[0];
    expect(group.companions).toEqual([]);
    expect(group.branches).toEqual([]);
    expect(group.lead.viewed).toBe(1000);
    expect(group.lead.answered).toBe(860);
    expect(group.lead.dropped).toBe(140);
    expect(group.lead.dropPct).toBe(14);
    expect(out.totals.entered).toBe(1000);
    // Percentiles cannot be averaged, so the busier variant's are kept rather
    // than a number that describes neither.
    expect(group.lead.p50Ms).toBe(4000);
    expect(group.lead.p90Ms).toBe(10000);
  });

  it("keeps a genuine second screen at a position distinct from a merged duplicate", () => {
    const rows = [
      row({ step_id: "step1", funnel_variant: "control-v1", step_position: 1, sort_index: 1, viewed: 500, answered: 450, dropped: 50 }),
      row({ step_id: "step1", funnel_variant: "treatment-v1", step_position: 1, sort_index: 1, viewed: 500, answered: 400, dropped: 100 }),
      row({ step_id: "step1b", funnel_variant: "control-v1", step_position: 1, sort_index: 2, viewed: 850, answered: 800, dropped: 50 }),
    ];
    const group = assembleFunnelResponse(rows, OPTIONS).steps[0];
    expect(group.lead.stepId).toBe("step1");
    expect(group.lead.viewed).toBe(1000);
    // step1b is a different step, so it stays its own screen.
    expect(group.companions.map((c) => c.stepId)).toEqual(["step1b"]);
  });
});
