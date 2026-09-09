import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockSignCookie } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSignCookie: vi.fn(),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({ rpc: mockRpc }),
}));
vi.mock('@repo/shared/quiz-session-cookie', () => ({
  QUIZ_SESSION_COOKIE_NAME: 'quiz_session_access',
  QUIZ_SESSION_COOKIE_MAX_AGE: 2592000,
  signQuizSessionCookie: mockSignCookie,
}));

const sessionId = '11111111-2222-4333-8444-555555555555';

async function post(body: unknown) {
  const { POST } = await import('../route');
  return POST(
    new Request('http://localhost/api/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mobile Safari' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/session/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: { revision: 0 }, error: null });
    mockSignCookie.mockResolvedValue('signed-quiz-cookie');
  });

  it('creates one versioned session and sets the signed access cookie', async () => {
    const response = await post({ sessionId, locale: 'en', source: 'quiz' });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('quiz_session_access=signed-quiz-cookie');
    await expect(response.json()).resolves.toMatchObject({
      session: { id: sessionId, revision: 0, status: 'active' },
    });
    expect(mockRpc).toHaveBeenCalledWith(
      'create_quiz_session',
      expect.objectContaining({
        p_session_id: sessionId,
        p_quiz_variant: 'boilerplate-v1',
        p_funnel_variant: 'main-v1',
        p_source: 'quiz',
      }),
    );
  });

  it('rejects unsupported locales before creating a row', async () => {
    const response = await post({ sessionId, locale: 'xx', source: 'quiz' });
    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of claiming an existing session id', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate' } });
    const response = await post({ sessionId, locale: 'en', source: 'quiz' });
    expect(response.status).toBe(409);
    expect(mockSignCookie).not.toHaveBeenCalled();
  });
});
