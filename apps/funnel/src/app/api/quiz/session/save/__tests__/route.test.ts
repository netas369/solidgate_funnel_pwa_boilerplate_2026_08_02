import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMaybeSingle, mockRpc, mockAuthorize } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockAuthorize: vi.fn(),
}));

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
const sessionId = "11111111-2222-4333-8444-555555555555";

async function post(body: unknown) {
  const { POST } = await import("../route");
  return POST(
    new Request("http://localhost/api/quiz/session/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/quiz/session/save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 2,
        status: "active",
        quiz_variant: "boilerplate-v1",
        quiz_answers: {},
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

  it("updates one complete answer object through the revision-safe database function", async () => {
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
      "save_quiz_session_progress",
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

  it("rejects a partial client state that would erase saved answers", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 2,
        status: "active",
        quiz_variant: "boilerplate-v1",
        quiz_answers: { gender: "female" },
      },
      error: null,
    });

    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: {},
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_QUIZ_ANSWERS",
        fields: { answers: "ANSWER_REMOVAL_NOT_ALLOWED" },
      },
    });
    expect(mockRpc).not.toHaveBeenCalled();
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

  it("rejects progress updates after the session becomes terminal", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 3,
        status: "completed",
        quiz_variant: "boilerplate-v1",
        quiz_answers: { gender: "female" },
      },
      error: null,
    });

    const response = await post({
      sessionId,
      expectedRevision: 3,
      answers: { gender: "female" },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SESSION_ALREADY_COMPLETED" },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does not record lead capture without an email in the same save", async () => {
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

  it("rejects sensitive metadata on a Quiz milestone", async () => {
    const response = await post({
      sessionId,
      expectedRevision: 2,
      answers: { gender: "female" },
      event: {
        eventId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        type: "step_completed",
        metadata: { answers: { gender: "female" } },
      },
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SENSITIVE_EVENT_METADATA" },
    });
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/quiz/session/save — CRO step activity", () => {
  const activityId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 2,
        status: "active",
        quiz_variant: "boilerplate-v1",
        quiz_answers: {},
      },
      error: null,
    });
    mockAuthorize.mockResolvedValue({ ok: true, userId: null, via: "quiz_cookie" });
    mockRpc.mockResolvedValue({
      data: { id: sessionId, status: "active", revision: 3, current_step_id: "step2" },
      error: null,
    });
  });

  function body(stepActivity?: unknown) {
    return {
      sessionId,
      expectedRevision: 2,
      currentStepId: "step2",
      answers: { gender: "female" },
      ...(stepActivity ? { stepActivity } : {}),
    };
  }

  it("forwards step ids to the RPC", async () => {
    const response = await post(
      body({ activityId, viewed: ["step2"], answered: ["step1"], skipped: [] }),
    );
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "save_quiz_session_progress",
      expect.objectContaining({
        p_step_activity: { viewed: ["step2"], answered: ["step1"], skipped: [] },
      }),
    );
  });

  it("sends null when the caller omits stepActivity — existing callers still work", async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "save_quiz_session_progress",
      expect.objectContaining({ p_step_activity: null }),
    );
  });

  it("keeps duplicate views (the counter) but dedupes answered and skipped", async () => {
    await post(
      body({
        activityId,
        viewed: ["step2", "step2"],
        answered: ["step1", "step1"],
        skipped: ["step3", "step3"],
      }),
    );
    expect(mockRpc).toHaveBeenCalledWith(
      "save_quiz_session_progress",
      expect.objectContaining({
        p_step_activity: {
          viewed: ["step2", "step2"],
          answered: ["step1"],
          skipped: ["step3"],
        },
      }),
    );
  });

  it("DROPS unknown step ids and still saves — a stale tab must not 400 forever", async () => {
    const response = await post(
      body({ activityId, viewed: ["step2", "ghost-step"], answered: [], skipped: [] }),
    );
    // A 400 here would leave that tab's buffer uncleared, so it would retry the
    // same unknown id indefinitely and stop persisting the visitor's answers.
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "save_quiz_session_progress",
      expect.objectContaining({
        p_step_activity: { viewed: ["step2"], answered: [], skipped: [] },
      }),
    );
  });

  it("sends null when every id was unknown, but still persists the answers", async () => {
    const response = await post(
      body({ activityId, viewed: ["ghost"], answered: ["phantom"], skipped: [] }),
    );
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "save_quiz_session_progress",
      expect.objectContaining({ p_step_activity: null }),
    );
  });

  it("rejects an over-long array before touching the database", async () => {
    const response = await post(
      body({
        activityId,
        viewed: Array.from({ length: 201 }, (_, i) => `step${i}`),
        answered: [],
        skipped: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid activityId", async () => {
    const response = await post(
      body({ activityId: "not-a-uuid", viewed: ["step2"], answered: [], skipped: [] }),
    );
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects an unknown key inside stepActivity (schema is strict)", async () => {
    const response = await post(
      body({ activityId, viewed: [], answered: [], skipped: [], viewedAt: "2026-01-01" }),
    );
    // The client must never be able to supply a timestamp.
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
