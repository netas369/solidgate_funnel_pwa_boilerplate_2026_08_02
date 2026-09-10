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

async function post(body: unknown, userAgent = 'Mobile Safari') {
  const { POST } = await import('../route');
  return POST(
    new Request('http://localhost/api/quiz/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/quiz/session/create', () => {
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

  it('persists structured first/last-touch attribution for later Meta matching', async () => {
    const attribution = {
      first_touch: {
        utm_source: 'facebook',
        utm_campaign: 'summer',
        fbclid: 'click-1',
        landing_url: 'https://funnel.example/en/quiz?utm_source=facebook',
        captured_at: '2026-09-11T08:00:00.000Z',
      },
      last_touch: {
        utm_source: 'facebook',
        fbclid: 'click-1',
        captured_at: '2026-09-11T08:00:00.000Z',
      },
      fbc: 'fb.1.1789113600000.click-1',
      fbp: 'fb.1.1789113600000.browser-1',
    };

    const response = await post({ sessionId, locale: 'en', source: 'quiz', attribution });

    expect(response.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith(
      'create_quiz_session',
      expect.objectContaining({ p_attribution: attribution }),
    );
  });

  it('rejects malformed Meta attribution cookies instead of persisting bad match data', async () => {
    const response = await post({
      sessionId,
      locale: 'en',
      source: 'quiz',
      attribution: {
        first_touch: { utm_source: 'facebook' },
        last_touch: { utm_source: 'facebook' },
        fbc: 'not-a-meta-cookie',
      },
    });

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'meta-webindexer/1.1',
    'meta-externalads/1.1',
    'meta-externalagent/1.1',
    'meta-externalfetcher/1.1',
    'Facebot',
  ])('does not persist a session for Meta crawler UA %s', async (userAgent) => {
    const response = await post({ sessionId, locale: 'en', source: 'quiz' }, userAgent);

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mockSignCookie).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    'Mozilla/5.0 Mobile Safari [FBAN/FB4A;FBAV/500.0.0.0]',
    'Mozilla/5.0 Mobile Instagram 350.0.0.0',
  ])('persists real visitors using a Meta in-app browser UA %s', async (userAgent) => {
    const response = await post({ sessionId, locale: 'en', source: 'quiz' }, userAgent);

    expect(response.status).toBe(201);
    expect(mockSignCookie).toHaveBeenCalledWith(sessionId);
    expect(mockRpc).toHaveBeenCalledTimes(1);
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
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('does not create an inaccessible row when Quiz cookie configuration fails', async () => {
    mockSignCookie.mockRejectedValue(new Error('QUIZ_SESSION_COOKIE_SECRET env var is not set'));

    const response = await post({ sessionId, locale: 'en', source: 'quiz' });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'QUIZ_SESSION_CONFIGURATION_ERROR' },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
