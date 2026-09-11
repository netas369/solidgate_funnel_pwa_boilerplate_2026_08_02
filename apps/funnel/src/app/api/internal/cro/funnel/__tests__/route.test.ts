import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRpc, mockMaybeSingle } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockMaybeSingle: vi.fn(),
}));

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: mockRpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}));

const FROM = "2026-09-01T00:00:00Z";
const TO = "2026-09-08T00:00:00Z";
const AUTH = { "x-internal-secret": "s3cret" };

async function get(query: string, headers: Record<string, string> = {}) {
  const { GET } = await import("../route");
  return GET(new Request(`http://localhost/api/internal/cro/funnel${query}`, { headers }));
}

function stepRow(over: Record<string, unknown>) {
  return {
    quiz_variant: "boilerplate-v1", funnel_variant: "main-v1",
    step_position: 1, sort_index: 1, step_type: "radio", phase_key: "phases.start",
    label: "A question", is_question: true, is_terminal: false,
    is_unconditional: true, entry_skippable: false, in_catalog: true,
    has_traffic: true, position_cohort: 0, viewed: 0, answered: 0, skipped: 0,
    advanced: 0, dropped: 0, unsettled: 0, total_views: 0, revisits: 0,
    p50_seconds_to_answer: null, p90_seconds_to_answer: null,
    ...over,
  };
}

describe("GET /api/internal/cro/funnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret");
    mockRpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "cro_step_funnel"
          ? {
              data: [
                stepRow({ step_id: "step1", viewed: 100, answered: 80, dropped: 20 }),
                stepRow({
                  step_id: "step2", step_position: 2, sort_index: 2,
                  viewed: 80, answered: 70, dropped: 10,
                }),
              ],
              error: null,
            }
          : {
              data: [
                { kind: "funnel", id: "main-v1", sessions: 100, first_seen: FROM, last_seen: TO },
                { kind: "version", id: "boilerplate-v1", sessions: 100, first_seen: FROM, last_seen: TO },
                { kind: "locale", id: "en", sessions: 100, first_seen: FROM, last_seen: TO },
              ],
              error: null,
            },
      ),
    );
    mockMaybeSingle.mockResolvedValue({
      data: {
        app_key: "boilerplate", funnel_key: "main",
        config_hash: "a".repeat(64), first_step_id: "step1", total_steps: 2,
      },
      error: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails CLOSED with 500 when the secret is unset, and never queries", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "not_configured" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong secret without querying", async () => {
    expect((await get(`?from=${FROM}&to=${TO}`)).status).toBe(401);
    expect((await get(`?from=${FROM}&to=${TO}`, { "x-internal-secret": "no" })).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires a valid range", async () => {
    expect((await get("", AUTH)).status).toBe(400);
    expect((await get(`?from=${TO}&to=${FROM}`, AUTH)).status).toBe(400);
    expect((await get("?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z", AUTH)).status).toBe(400);
    expect((await get(`?from=${FROM}&to=${TO}&bogus=1`, AUTH)).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns a display-ready funnel the dashboard can render without arithmetic", async () => {
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.contract).toBe(1);
    expect(json.app.capabilities).toEqual(["overview", "dropoff"]);
    expect(json.totals).toMatchObject({ entered: 100, smallSample: false });
    expect(json.steps[0]).toMatchObject({
      displayIndex: 1,
      reached: 100,
      barPct: 100,
      severity: "notable",
      severityLabel: "Noticeable drop",
    });
    // A position has no label of its own — the row title IS the lead's label,
    // matching how FunnelRows reads it in carnivore-app and glp-app.
    expect(json.steps[0].lead).toMatchObject({ label: "A question", dropPct: 20 });
    // Names come from the APP's registry, so the dashboard holds no per-product
    // knowledge and its pickers never render raw ids.
    expect(json.segments.versions[0]).toMatchObject({
      id: "boilerplate-v1",
      label: "Boilerplate v1",
      sessions: 100,
    });
    expect(json.segments.versions[0].note).toBeTruthy();
    expect(json.segments.funnels[0]).toMatchObject({ id: "main-v1", label: "Main funnel" });
    expect(json.segments.locales[0]).toMatchObject({ id: "en", label: "English" });
  });

  it("defaults the version to what this deployment writes", async () => {
    await get(`?from=${FROM}&to=${TO}`, AUTH);
    expect(mockRpc).toHaveBeenCalledWith(
      "cro_step_funnel",
      expect.objectContaining({ p_quiz_variant: "boilerplate-v1", p_funnel_variant: null }),
    );
  });

  it("passes funnel, locale and source filters through", async () => {
    await get(`?from=${FROM}&to=${TO}&funnel=alt-v2&locale=en&source=quiz`, AUTH);
    expect(mockRpc).toHaveBeenCalledWith(
      "cro_step_funnel",
      expect.objectContaining({
        p_funnel_variant: "alt-v2", p_locale: "en", p_source: "quiz",
      }),
    );
  });

  it("warns rather than guesses when the catalog was never published", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const json = await (await get(`?from=${FROM}&to=${TO}`, AUTH)).json();
    expect(json.quiz.configHash).toBeNull();
    expect(json.warnings.map((w: { code: string }) => w.code)).toContain("CATALOG_NOT_PUBLISHED");
  });

  it("surfaces a query failure as 500, never as an empty funnel", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const response = await get(`?from=${FROM}&to=${TO}`, AUTH);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "query_failed" });
  });
});
