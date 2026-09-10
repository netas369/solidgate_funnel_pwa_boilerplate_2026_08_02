import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUser, mockMaybeSingle, mockRpc, mockAuthorize } = vi.hoisted(
  () => ({
    mockGetUser: vi.fn(),
    mockMaybeSingle: vi.fn(),
    mockRpc: vi.fn(),
    mockAuthorize: vi.fn(),
  }),
);

vi.mock("@repo/shared/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: mockGetUser } }),
}));
vi.mock("@repo/shared/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
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
    new Request("http://localhost/api/quiz/session/link-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/quiz/session/link-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockMaybeSingle.mockResolvedValue({
      data: { id: sessionId, user_id: null },
      error: null,
    });
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: "user-1",
      via: "quiz_cookie",
    });
    mockRpc.mockResolvedValue({
      data: { id: sessionId, user_id: "user-1" },
      error: null,
    });
  });

  it("links an accessible anonymous session to the authenticated user", async () => {
    const response = await post({ sessionId });

    expect(response.status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledWith(sessionId, null);
    expect(mockRpc).toHaveBeenCalledWith("link_quiz_session_user", {
      p_session_id: sessionId,
      p_user_id: "user-1",
    });
  });

  it("requires authentication before reading or linking the session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const response = await post({ sessionId });

    expect(response.status).toBe(401);
    expect(mockMaybeSingle).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns a conflict when the database prevents ownership reassignment", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "QUIZ_SESSION_OWNERSHIP_MISMATCH" },
    });

    const response = await post({ sessionId });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SESSION_OWNERSHIP_MISMATCH" },
    });
  });
});
