import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMaybeSingle, mockRpc, mockAuthorize } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockAuthorize: vi.fn(),
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
const eventId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function post(body: unknown) {
  const { POST } = await import("../route");
  return POST(
    new Request("http://localhost/api/funnel-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/funnel-events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeSingle.mockResolvedValue({
      data: { id: sessionId, user_id: null },
      error: null,
    });
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: null,
      via: "quiz_cookie",
    });
    mockRpc.mockResolvedValue({ data: eventId, error: null });
  });

  it("records an allowed event through the idempotent database function", async () => {
    const response = await post({
      eventId,
      sessionId,
      type: "offer_viewed",
      metadata: { offer_code: "main" },
    });
    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      "record_funnel_event",
      expect.objectContaining({
        p_event_id: eventId,
        p_event_type: "offer_viewed",
      }),
    );
  });

  it("rejects server-owned completion events from the public route", async () => {
    const response = await post({ eventId, sessionId, type: "quiz_completed" });
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects payment-confirmed events from the public route", async () => {
    const response = await post({
      eventId,
      sessionId,
      type: "checkout_completed",
    });
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects client timestamps outside the delivery window", async () => {
    const response = await post({
      eventId,
      sessionId,
      type: "offer_viewed",
      occurredAt: "2000-01-01T00:00:00.000Z",
    });
    expect(response.status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
