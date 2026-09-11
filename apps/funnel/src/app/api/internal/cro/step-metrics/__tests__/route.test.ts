import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({ rpc: mockRpc }),
}));

const FROM = "2026-09-01T00:00:00Z";
const TO = "2026-09-08T00:00:00Z";

async function get(query: string, headers: Record<string, string> = {}) {
  const { GET } = await import("../route");
  return GET(new Request(`http://localhost/api/internal/cro/step-metrics${query}`, { headers }));
}

const AUTH = { "x-internal-secret": "s3cret" };

describe("GET /api/internal/cro/step-metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret");
    mockRpc.mockResolvedValue({ data: [], error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails CLOSED with 500 when the secret is unset, and never queries", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    // Deliberately not a 401: an unset secret is a misconfiguration, and
    // reporting it as an auth failure sends the operator hunting a credential.
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "not_configured" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without querying", async () => {
    expect((await get(`?from=${FROM}&to=${TO}`)).status).toBe(401);
    expect(
      (await get(`?from=${FROM}&to=${TO}`, { "x-internal-secret": "wrong" })).status,
    ).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires a range — a dashboard that forgets it must not get a year of rows", async () => {
    const response = await get("", AUTH);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_query" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects an inverted range", async () => {
    const response = await get(`?from=${TO}&to=${FROM}`, AUTH);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_range" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a range longer than a year", async () => {
    const response = await get(
      `?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`,
      AUTH,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "range_too_large" });
  });

  it("rejects an unexpected query parameter", async () => {
    const response = await get(`?from=${FROM}&to=${TO}&limit=5`, AUTH);
    expect(response.status).toBe(400);
  });

  it("passes the range and filters through verbatim", async () => {
    await get(`?from=${FROM}&to=${TO}&quizVariant=boilerplate-v1`, AUTH);
    expect(mockRpc).toHaveBeenCalledWith(
      "cro_step_funnel",
      expect.objectContaining({
        p_from: FROM,
        p_to: TO,
        p_quiz_variant: "boilerplate-v1",
        p_funnel_variant: null,
      }),
    );
  });

  it("maps rows to camelCase and keys them by stepId, never stepNumber", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          quiz_variant: "boilerplate-v1",
          funnel_variant: "main-v1",
          step_id: "step3",
          step_position: 3,
          sort_index: 3,
          step_type: "multi_select",
          phase_key: "phases.about",
          label: "Which challenges?",
          is_question: true,
          is_terminal: false,
          is_unconditional: false,
          entry_skippable: false,
          in_catalog: true,
          has_traffic: true,
          position_cohort: 100,
          viewed: 60,
          answered: 55,
          skipped: 0,
          advanced: 55,
          dropped: 5,
          unsettled: 0,
          total_views: 66,
          revisits: 6,
          p50_seconds_to_answer: 4.5,
          p90_seconds_to_answer: 19.2,
        },
      ],
      error: null,
    });
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.steps[0]).toMatchObject({
      stepId: "step3",
      position: 3,
      label: "Which challenges?",
      isQuestion: true,
      // The branch-vs-drop signal must survive to the wire.
      isUnconditional: false,
      entrySkippable: false,
      inCatalog: true,
      hasTraffic: true,
      viewed: 60,
      answered: 55,
      dropped: 5,
      p90SecondsToAnswer: 19.2,
    });
    expect(json.steps[0]).not.toHaveProperty("stepNumber");
  });

  it("passes through a published step that saw nobody", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          quiz_variant: "boilerplate-v1", funnel_variant: "main-v1",
          step_id: "step7", step_position: 7, sort_index: 8,
          step_type: "loading_screen", phase_key: "phases.account",
          label: "Building your plan",
          is_question: false, is_terminal: true, is_unconditional: true,
          entry_skippable: false, in_catalog: true, has_traffic: false,
          position_cohort: 0, viewed: 0, answered: 0, skipped: 0,
          advanced: 0, dropped: 0, unsettled: 0, total_views: 0, revisits: 0,
          p50_seconds_to_answer: null, p90_seconds_to_answer: null,
        },
      ],
      error: null,
    });
    const json = await (await get(`?from=${FROM}&to=${TO}`, AUTH)).json();
    // A zero-traffic step must reach the dashboard rather than be filtered out:
    // otherwise "nobody got this far" and "this step does not exist" render
    // identically, and a step shown to zero people is invisible.
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0]).toMatchObject({
      stepId: "step7", hasTraffic: false, viewed: 0, dropped: 0,
    });
  });

  it("surfaces a query failure as 500, never as an empty result", async () => {
    // A machine consumer handed 0 instead of a 500 draws a chart with a cliff
    // in it and nobody notices.
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "query_failed" });
  });
});
