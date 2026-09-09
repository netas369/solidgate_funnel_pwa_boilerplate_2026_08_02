import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMaybeSingle, mockRpc, mockAuthorize } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockAuthorize: vi.fn(),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
    rpc: mockRpc,
  }),
}));
vi.mock('@/features/quiz/server/quiz-access', () => ({
  authorizeQuizSession: mockAuthorize,
}));

const sessionId = '11111111-2222-4333-8444-555555555555';
const completeAnswers = {
  gender: 'female',
  primaryGoal: 'a',
  challenges: ['o1'],
  fullName: 'Alex',
  email: 'alex@example.com',
  userEmail: 'alex@example.com',
};

async function post(body: unknown) {
  const { POST } = await import('../route');
  return POST(
    new Request('http://localhost/api/session/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/session/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: null, via: 'quiz_cookie' });
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 7,
        status: 'active',
        quiz_variant: 'boilerplate-v1',
        quiz_answers: completeAnswers,
        quiz_result: null,
        result_segment: null,
        completed_at: null,
      },
      error: null,
    });
    mockRpc.mockResolvedValue({
      data: {
        status: 'completed',
        revision: 8,
        quiz_result: { score_version: 'boilerplate-v1', profile: 'a' },
        result_segment: 'a',
        completed_at: '2026-09-09T10:20:00Z',
      },
      error: null,
    });
  });

  it('computes and stores the result on the server', async () => {
    const response = await post({ sessionId, expectedRevision: 7 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'completed',
      revision: 8,
      resultSegment: 'a',
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_quiz_session',
      expect.objectContaining({
        p_session_id: sessionId,
        p_expected_revision: 7,
        p_result_segment: 'a',
        p_quiz_result: expect.objectContaining({ score_version: 'boilerplate-v1' }),
      }),
    );
  });

  it('rejects incomplete stored answers', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 7,
        status: 'active',
        quiz_variant: 'boilerplate-v1',
        quiz_answers: { gender: 'female', primaryGoal: 'a' },
        quiz_result: null,
        result_segment: null,
        completed_at: null,
      },
      error: null,
    });
    const response = await post({ sessionId, expectedRevision: 7 });
    expect(response.status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns the existing result idempotently', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: null,
        revision: 8,
        status: 'completed',
        quiz_variant: 'boilerplate-v1',
        quiz_answers: completeAnswers,
        quiz_result: { score_version: 'boilerplate-v1', profile: 'a' },
        result_segment: 'a',
        completed_at: '2026-09-09T10:20:00Z',
      },
      error: null,
    });
    const response = await post({ sessionId, expectedRevision: 7 });
    expect(response.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
