import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMaybeSingle, mockRpc, mockAuthorize, mockAddContact } = vi.hoisted(
  () => ({
    mockMaybeSingle: vi.fn(),
    mockRpc: vi.fn(),
    mockAuthorize: vi.fn(),
    mockAddContact: vi.fn(),
  }),
);

vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockMaybeSingle }),
      }),
    }),
    rpc: mockRpc,
  }),
}));
vi.mock("@/features/quiz/server/quiz-access", () => ({
  authorizeQuizSession: mockAuthorize,
}));
vi.mock("@/lib/activecampaign/client", () => ({
  addContactToEmailList: mockAddContact,
}));

const sessionId = "11111111-2222-4333-8444-555555555555";

async function post(body: unknown) {
  const { POST } = await import("../route");
  return POST(
    new Request("http://localhost/api/session/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/session/snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 2,
        status: "active",
        quiz_variant: "boilerplate-v1",
        locale: "en",
      },
      error: null,
    });
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: null,
      via: "quiz_cookie",
    });
    mockRpc.mockResolvedValue({
      data: { revision: 3, current_step_id: "step2", status: "active" },
      error: null,
    });
  });

  it("updates one full snapshot through the revision-safe database function", async () => {
    const response = await post({
      sessionId,
      expectedRevision: 2,
      currentStepId: "step2",
      answers: { gender: "female" },
      event: {
        eventId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        type: "step_completed",
        stepNumber: 1,
        metadata: { step_id: "step1" },
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      revision: 3,
      currentStepId: "step2",
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "persist_quiz_session_snapshot",
      expect.objectContaining({
        p_session_id: sessionId,
        p_expected_revision: 2,
        p_quiz_answers: { gender: "female" },
        p_event_type: "step_completed",
      }),
    );
  });

  it("rejects an invalid answer without touching the database", async () => {
    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: { gender: "robot" },
    });
    expect(response.status).toBe(422);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns the canonical stale-revision conflict", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "QUIZ_STALE_REVISION:5", code: "40001" },
    });
    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: { gender: "female" },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STALE_SESSION_REVISION" },
      currentRevision: 5,
    });
  });

  it("rejects a caller without session access", async () => {
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 401,
      code: "UNAUTHORIZED_SESSION",
    });
    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: { gender: "female" },
    });
    expect(response.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does not record lead capture without an email in the same snapshot", async () => {
    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: { gender: "female" },
      event: {
        eventId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        type: "lead_captured",
      },
    });

    expect(response.status).toBe(422);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
