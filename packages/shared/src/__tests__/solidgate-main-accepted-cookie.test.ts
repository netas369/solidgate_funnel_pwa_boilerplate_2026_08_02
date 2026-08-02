import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.PAYMENT_COOKIE_SECRET = 'test-secret-32-chars-long-enough!!';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Solidgate main accepted cookie', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const orderId = `${sessionId}:trial1:1`;
  const binding = { orderId, sessionId, paymentEnvironment: 'sandbox' as const };

  it('roundtrips an environment-bound order and session', async () => {
    const {
      signSolidgateMainAcceptedCookie,
      verifySolidgateMainAcceptedCookie,
    } = await import('../solidgate/main-accepted-cookie');

    const cookie = await signSolidgateMainAcceptedCookie(binding);

    expect(await verifySolidgateMainAcceptedCookie(cookie)).toEqual(binding);
  });

  it('uses a purpose-scoped format that is not payment_access', async () => {
    const {
      signSolidgateMainAcceptedCookie,
      verifySolidgateMainAcceptedCookie,
    } = await import('../solidgate/main-accepted-cookie');
    const { signPaymentCookie, verifyPaymentCookie } = await import('../payment-cookie');

    const acceptedCookie = await signSolidgateMainAcceptedCookie(binding);
    const paymentCookie = await signPaymentCookie(orderId, sessionId);

    expect(await verifyPaymentCookie(acceptedCookie)).toBeNull();
    expect(await verifySolidgateMainAcceptedCookie(paymentCookie)).toBeNull();
  });

  it('expires cryptographically after ten minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T10:00:00Z'));
    const {
      SOLIDGATE_MAIN_ACCEPTED_MAX_AGE,
      signSolidgateMainAcceptedCookie,
      verifySolidgateMainAcceptedCookie,
    } = await import('../solidgate/main-accepted-cookie');
    const cookie = await signSolidgateMainAcceptedCookie(binding);

    vi.setSystemTime(new Date('2026-07-21T10:09:59Z'));
    expect(await verifySolidgateMainAcceptedCookie(cookie)).toEqual(binding);

    vi.setSystemTime(new Date('2026-07-21T10:10:00Z'));
    expect(await verifySolidgateMainAcceptedCookie(cookie)).toBeNull();
    expect(SOLIDGATE_MAIN_ACCEPTED_MAX_AGE).toBe(600);
  });

  it.each([
    '',
    'v1',
    'v1.payload',
    'v1.payload.signature.extra',
    'v2.payload.signature',
    'v1..signature',
    'v1.payload.',
  ])('rejects malformed value %j', async (value) => {
    const { verifySolidgateMainAcceptedCookie } = await import(
      '../solidgate/main-accepted-cookie'
    );
    expect(await verifySolidgateMainAcceptedCookie(value)).toBeNull();
  });

  it('rejects tampered payloads and signatures', async () => {
    const {
      signSolidgateMainAcceptedCookie,
      verifySolidgateMainAcceptedCookie,
    } = await import('../solidgate/main-accepted-cookie');
    const parts = (await signSolidgateMainAcceptedCookie(binding)).split('.');
    const payloadParts = [...parts];
    payloadParts[1] = `${payloadParts[1].slice(0, -1)}${payloadParts[1].endsWith('A') ? 'B' : 'A'}`;
    const signatureParts = [...parts];
    signatureParts[2] = `${signatureParts[2].slice(0, -1)}${signatureParts[2].endsWith('A') ? 'B' : 'A'}`;

    expect(await verifySolidgateMainAcceptedCookie(payloadParts.join('.'))).toBeNull();
    expect(await verifySolidgateMainAcceptedCookie(signatureParts.join('.'))).toBeNull();
  });

  it('binds the signature to the payment environment', async () => {
    const { signSolidgateMainAcceptedCookie } = await import(
      '../solidgate/main-accepted-cookie'
    );

    const sandbox = await signSolidgateMainAcceptedCookie(binding);
    const production = await signSolidgateMainAcceptedCookie({
      ...binding,
      paymentEnvironment: 'production',
    });

    expect(sandbox).not.toBe(production);
  });

  it('rejects invalid or mismatched signing bindings', async () => {
    const { signSolidgateMainAcceptedCookie } = await import(
      '../solidgate/main-accepted-cookie'
    );

    await expect(signSolidgateMainAcceptedCookie({
      ...binding,
      sessionId: 'not-a-uuid',
    })).rejects.toThrow();
    await expect(signSolidgateMainAcceptedCookie({
      ...binding,
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).rejects.toThrow();
    await expect(signSolidgateMainAcceptedCookie({
      ...binding,
      paymentEnvironment: 'preview' as 'sandbox',
    })).rejects.toThrow();
  });

  it('exports the dedicated cookie name', async () => {
    const { SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME } = await import(
      '../solidgate/main-accepted-cookie'
    );
    expect(SOLIDGATE_MAIN_ACCEPTED_COOKIE_NAME).toBe('solidgate_main_accepted');
  });
});
