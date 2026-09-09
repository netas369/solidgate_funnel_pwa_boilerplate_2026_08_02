import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signQuizSessionCookie, verifyQuizSessionCookie } from '../quiz-session-cookie';

describe('quiz session cookie', () => {
  beforeEach(() => {
    vi.stubEnv('PAYMENT_COOKIE_SECRET', 'test-secret-that-is-long-enough-for-hmac');
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
});
