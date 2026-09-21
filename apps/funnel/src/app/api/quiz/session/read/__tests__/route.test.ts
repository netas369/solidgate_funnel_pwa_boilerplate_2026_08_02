import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthorize, mockSelectSingle } = vi.hoisted(() => ({
  mockAuthorize: vi.fn(),
  mockSelectSingle: vi.fn(),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: mockSelectSingle,
        })),
      })),
    })),
  })),
}));

vi.mock('@/features/quiz/server/quiz-access', () => ({
  authorizeQuizSession: mockAuthorize,
}));

async function getRoute(sessionId?: string) {
  const { GET } = await import('../route');
  const url = sessionId
    ? `http://localhost/api/quiz/session/read?sessionId=${sessionId}`
    : 'http://localhost/api/quiz/session/read';
  return GET(new Request(url));
}

describe('GET /api/quiz/session/read', () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: null,
      via: 'quiz_cookie',
    });
  });

  it('returns 400 for a missing sessionId query parameter', async () => {
    const response = await getRoute();

    expect(response.status).toBe(400);
    expect(mockSelectSingle).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid sessionId', async () => {
    const response = await getRoute('not-a-uuid');

    expect(response.status).toBe(400);
    expect(mockSelectSingle).not.toHaveBeenCalled();
  });

  it('returns 404 when the session does not exist', async () => {
    mockSelectSingle.mockResolvedValue({ data: null });

    const response = await getRoute(sessionId);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_NOT_FOUND' },
    });
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('returns only quiz session data after authorization', async () => {
    mockSelectSingle.mockResolvedValue({
      data: {
        id: sessionId,
        user_id: 'uid-1',
        current_step_id: 'step3',
        quiz_answers: { primaryGoal: 'a' },
        quiz_result: null,
        result_segment: null,
        status: 'active',
        revision: 2,
        quiz_variant: 'boilerplate-v1',
        funnel_variant: 'main-v1',
        locale: 'en',
        source: 'advertorial',
        completed_at: null,
      },
    });
    mockAuthorize.mockResolvedValue({
      ok: true,
      userId: 'uid-1',
      via: 'account',
    });

    const response = await getRoute(sessionId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: sessionId,
      current_step_id: 'step3',
      revision: 2,
    });
    expect(mockAuthorize).toHaveBeenCalledWith(sessionId, 'uid-1');
  });

  it('returns the authorization failure without consulting Payment', async () => {
    mockSelectSingle.mockResolvedValue({ data: { id: sessionId, user_id: 'uid-other' } });
    mockAuthorize.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'SESSION_OWNERSHIP_MISMATCH',
    });

    const response = await getRoute(sessionId);

    expect(response.status).toBe(403);
  });
});
