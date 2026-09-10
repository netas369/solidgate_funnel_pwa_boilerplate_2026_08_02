import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCookie, mockGetUser, mockVerifyQuizCookie } = vi.hoisted(() => ({
  mockGetCookie: vi.fn(),
  mockGetUser: vi.fn(),
  mockVerifyQuizCookie: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({ get: mockGetCookie })),
}));

vi.mock('@repo/shared/quiz-session-cookie', () => ({
  QUIZ_SESSION_COOKIE_NAME: 'quiz_session_access',
  verifyQuizSessionCookie: mockVerifyQuizCookie,
}));

vi.mock('@repo/shared/supabase/server', () => ({
  createClient: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } })),
}));

import { authorizeQuizSession } from '../quiz-access';

describe('authorizeQuizSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCookie.mockReturnValue(undefined);
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockVerifyQuizCookie.mockResolvedValue(null);
  });

  it('authorizes the authenticated session owner', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    await expect(authorizeQuizSession('session-1', 'user-1')).resolves.toEqual({
      ok: true,
      userId: 'user-1',
      via: 'account',
    });
    expect(mockGetCookie).not.toHaveBeenCalled();
  });

  it('authorizes an anonymous session with its matching Quiz cookie', async () => {
    mockGetCookie.mockImplementation((name: string) =>
      name === 'quiz_session_access' ? { value: 'signed-quiz-cookie' } : undefined,
    );
    mockVerifyQuizCookie.mockResolvedValue('session-1');

    await expect(authorizeQuizSession('session-1', null)).resolves.toEqual({
      ok: true,
      userId: null,
      via: 'quiz_cookie',
    });
    expect(mockGetCookie).toHaveBeenCalledTimes(1);
    expect(mockGetCookie).toHaveBeenCalledWith('quiz_session_access');
  });

  it('does not treat knowledge of a session id as authorization', async () => {
    await expect(authorizeQuizSession('session-1', null)).resolves.toEqual({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED_SESSION',
    });
  });

  it('rejects an authenticated user when another user owns the session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    await expect(authorizeQuizSession('session-1', 'user-2')).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'SESSION_OWNERSHIP_MISMATCH',
    });
  });

  it('fails closed when authentication lookup fails unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'NetworkError', message: 'auth unavailable' },
    });

    await expect(authorizeQuizSession('session-1', null)).resolves.toEqual({
      ok: false,
      status: 500,
      code: 'AUTH_LOOKUP_FAILED',
    });
    consoleSpy.mockRestore();
  });

  it('fails closed when Quiz cookie verification is not configured', async () => {
    mockGetCookie.mockReturnValue({ value: 'signed-quiz-cookie' });
    mockVerifyQuizCookie.mockRejectedValue(new Error('secret missing'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(authorizeQuizSession('session-1', null)).resolves.toEqual({
      ok: false,
      status: 500,
      code: 'QUIZ_SESSION_CONFIGURATION_ERROR',
    });
    consoleSpy.mockRestore();
  });
});
