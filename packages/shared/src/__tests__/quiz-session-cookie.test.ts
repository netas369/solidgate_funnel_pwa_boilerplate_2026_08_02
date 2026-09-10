import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signQuizSessionCookie, verifyQuizSessionCookie } from '../quiz-session-cookie';

describe('quiz session cookie', () => {
  beforeEach(() => {
    vi.stubEnv('QUIZ_SESSION_COOKIE_SECRET', 'test-secret-that-is-long-enough-for-hmac');
  });

  it('round-trips the bound session id', async () => {
    const cookie = await signQuizSessionCookie('session-123');
    await expect(verifyQuizSessionCookie(cookie)).resolves.toBe('session-123');
  });

  it('rejects a tampered cookie', async () => {
    const cookie = await signQuizSessionCookie('session-123');
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    await expect(verifyQuizSessionCookie(tampered)).resolves.toBeNull();
  });

  it('rejects malformed input', async () => {
    await expect(verifyQuizSessionCookie('not-a-cookie')).resolves.toBeNull();
  });

  it('fails closed when the Quiz secret is missing', async () => {
    vi.stubEnv('QUIZ_SESSION_COOKIE_SECRET', '');

    await expect(signQuizSessionCookie('session-123')).rejects.toThrow(
      'QUIZ_SESSION_COOKIE_SECRET env var is not set',
    );
  });

  it('rejects a Quiz secret that is too short', async () => {
    vi.stubEnv('QUIZ_SESSION_COOKIE_SECRET', 'too-short');

    await expect(signQuizSessionCookie('session-123')).rejects.toThrow(
      'QUIZ_SESSION_COOKIE_SECRET must contain at least 32 characters',
    );
  });
});
