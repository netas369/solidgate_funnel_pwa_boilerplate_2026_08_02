import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.PAYMENT_COOKIE_SECRET = 'test-secret-32-chars-long-enough!!';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('payment-cookie (expiring session-bound HMAC)', () => {
  const id = 'order_3PxABC1234567890';
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';

  it('roundtrips a PI-kind cookie', async () => {
    const { signPaymentCookie, verifyPaymentCookie } = await import('../payment-cookie');
    const cookie = await signPaymentCookie(id, sessionId);

    expect(await verifyPaymentCookie(cookie)).toEqual({
      kind: 'pi',
      id,
      paymentIntentId: id,
      sessionId,
      subscriptionId: null,
    });
  });

  it('roundtrips a subscription-kind cookie', async () => {
    const { signPaymentCookie, verifyPaymentCookie } = await import('../payment-cookie');
    const subscriptionId = 'sub_1PxABC1234567890';
    const cookie = await signPaymentCookie(subscriptionId, sessionId, { kind: 'sub' });

    expect(await verifyPaymentCookie(cookie)).toEqual({
      kind: 'sub',
      id: subscriptionId,
      paymentIntentId: null,
      sessionId,
      subscriptionId,
    });
  });

  it('issues a versioned three-part base64url cookie', async () => {
    const { signPaymentCookie } = await import('../payment-cookie');
    const parts = (await signPaymentCookie(id, sessionId)).split('.');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('expires cryptographically after 90 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T10:00:00Z'));
    const { signPaymentCookie, verifyPaymentCookie, PAYMENT_COOKIE_MAX_AGE } = await import(
      '../payment-cookie'
    );
    const cookie = await signPaymentCookie(id, sessionId);

    vi.setSystemTime(new Date('2026-07-16T11:29:59Z'));
    expect(await verifyPaymentCookie(cookie)).not.toBeNull();

    vi.setSystemTime(new Date('2026-07-16T11:30:00Z'));
    expect(await verifyPaymentCookie(cookie)).toBeNull();
    expect(PAYMENT_COOKIE_MAX_AGE).toBe(5400);
  });

  it('rejects old unexpiring cookie formats', async () => {
    const { verifyPaymentCookie } = await import('../payment-cookie');
    expect(await verifyPaymentCookie(`${id}.${sessionId}.fake-signature`)).toBeNull();
    expect(await verifyPaymentCookie(`sub:${id}.${sessionId}.fake-signature`)).toBeNull();
  });

  it.each([
    '',
    'v2',
    'v2.payload',
    'v2.payload.signature.extra',
    'v1.payload.signature',
    'v2..signature',
    'v2.payload.',
  ])('rejects malformed value %j', async (value) => {
    const { verifyPaymentCookie } = await import('../payment-cookie');
    expect(await verifyPaymentCookie(value)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { signPaymentCookie, verifyPaymentCookie } = await import('../payment-cookie');
    const parts = (await signPaymentCookie(id, sessionId)).split('.');
    parts[1] = `${parts[1].slice(0, -1)}${parts[1].endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyPaymentCookie(parts.join('.'))).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { signPaymentCookie, verifyPaymentCookie } = await import('../payment-cookie');
    const parts = (await signPaymentCookie(id, sessionId)).split('.');
    parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyPaymentCookie(parts.join('.'))).toBeNull();
  });

  it('binds the cookie to both payment id and session id', async () => {
    const { signPaymentCookie } = await import('../payment-cookie');
    const base = await signPaymentCookie(id, sessionId);
    const otherId = await signPaymentCookie('other-order', sessionId);
    const otherSession = await signPaymentCookie(id, 'other-session');

    expect(base).not.toBe(otherId);
    expect(base).not.toBe(otherSession);
  });

  it('rejects empty signing inputs', async () => {
    const { signPaymentCookie } = await import('../payment-cookie');
    await expect(signPaymentCookie('', sessionId)).rejects.toThrow();
    await expect(signPaymentCookie(id, '')).rejects.toThrow();
  });

  it('exports the payment_access cookie name', async () => {
    const { PAYMENT_COOKIE_NAME } = await import('../payment-cookie');
    expect(PAYMENT_COOKIE_NAME).toBe('payment_access');
  });
});
