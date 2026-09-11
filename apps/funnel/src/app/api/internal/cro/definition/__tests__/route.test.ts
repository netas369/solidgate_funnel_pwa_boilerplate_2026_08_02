import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({ from: mockFrom }),
}));

const AUTH = { "x-internal-secret": "s3cret" };

const DEFINITION = {
  quiz_variant: "boilerplate-v1",
  app_key: "testapp",
  funnel_key: "main",
  first_step_id: "step1",
  total_steps: 7,
  config_hash: "a".repeat(64),
  published_at: "2026-09-11T08:00:00Z",
};

const STEPS = [
  {
    step_id: "step3",
    position: 3,
    sort_index: 3,
    step_type: "multi_select",
    phase_key: "phases.about",
    store_as: "challenges",
    is_question: true,
    is_terminal: false,
    answer_keys: ["challenges"],
    label_key: "steps.step3.question",
    label: "Which challenges?",
    is_unconditional: false,
    entry_skippable: false,
  },
  {
    step_id: "step3b",
    position: 3,
    sort_index: 4,
    step_type: "checkpoint_reveal",
    phase_key: "phases.about",
    store_as: null,
    is_question: false,
    is_terminal: false,
    answer_keys: [],
    label_key: "steps.step3b.title",
    label: "Here is what that means",
    is_unconditional: false,
    entry_skippable: false,
  },
];

const EDGES = [{ from_step_id: "step3", to_step_id: "step4", on_value: null, edge_index: 0 }];

/** Chainable literal matching the route's three query shapes. */
function wireQueries(options: {
  definition?: unknown;
  definitionError?: { message: string } | null;
  stepsError?: { message: string } | null;
} = {}) {
  mockFrom.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () =>
          Promise.resolve({
            data: options.definition === undefined ? DEFINITION : options.definition,
            error: options.definitionError ?? null,
          }),
        order: () =>
          Promise.resolve({
            data: table === "quiz_definition_steps" ? STEPS : EDGES,
            error: options.stepsError ?? null,
          }),
      }),
    }),
  }));
}

async function get(query = "", headers: Record<string, string> = {}) {
  const { GET } = await import("../route");
  return GET(new Request(`http://localhost/api/internal/cro/definition${query}`, { headers }));
}

describe("GET /api/internal/cro/definition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret");
    wireQueries();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails CLOSED with 500 when the secret is unset, and never queries", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    const response = await get("", AUTH);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "not_configured" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without querying", async () => {
    expect((await get()).status).toBe(401);
    expect((await get("", { "x-internal-secret": "nope" })).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects an unexpected query parameter", async () => {
    const response = await get("?bogus=1", AUTH);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_query" });
  });

  it("returns the definition with branch arms cross-referenced", async () => {
    const response = await get("", AUTH);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.quiz.quizVariant).toBe("boilerplate-v1");
    expect(json.app).toEqual({ appKey: "testapp", funnelKey: "main" });
    // This is what lets the dashboard sum the arms instead of reading the dip
    // at position 3 as a drop.
    expect(json.steps[0]).toMatchObject({
      stepId: "step3",
      // A resolved sentence, never the i18n key.
      label: "Which challenges?",
      labelKey: "steps.step3.question",
      isQuestion: true,
      isUnconditional: false,
      entrySkippable: false,
      sharesPositionWith: ["step3b"],
      nextSteps: [{ to: "step4", on: null }],
    });
    expect(json.steps[1]).toMatchObject({
      stepId: "step3b",
      isQuestion: false,
      sharesPositionWith: ["step3"],
    });
  });

  it("reports what this deployment is writing right now", async () => {
    const json = await (await get("", AUTH)).json();
    // With no activation flag in the catalog, the deployed constant IS the
    // answer to "which version is live".
    expect(json.live.quizVariant).toBe("boilerplate-v1");
    expect(json.live.funnelVariant).toBe("main-v1");
  });

  it("404s when the variant was never published", async () => {
    wireQueries({ definition: null });
    const response = await get("?quizVariant=never-shipped-v9", AUTH);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_published" });
  });

  it("surfaces a query failure as 500", async () => {
    wireQueries({ definitionError: { message: "boom" } });
    const response = await get("", AUTH);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "query_failed" });
  });
});
