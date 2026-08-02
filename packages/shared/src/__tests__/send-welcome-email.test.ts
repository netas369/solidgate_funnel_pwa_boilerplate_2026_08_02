import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sendWelcomeEmail,
  sendPreparedWelcomeEmailDetailed,
  WELCOME_EMAIL_TIMEOUT_MS,
} from '../email/send-welcome-email';

const originalApiKey = process.env.RESEND_API_KEY;

describe('sendWelcomeEmail deadline', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'resend-test-key';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
  });

  it('returns false instead of blocking a paid redirect past five seconds', async () => {
    vi.useFakeTimers();
    let announce!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      announce = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('expected welcome-email deadline');
      announce(signal);
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(
          signal.reason ?? new DOMException('Aborted', 'AbortError'),
        );
        if (signal.aborted) rejectAbort();
        else signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }));

    const send = sendWelcomeEmail({
      email: 'buyer@example.com',
      pwaUrl: 'https://app.example.com',
      locale: 'lt',
    });
    const signal = await started;
    await vi.advanceTimersByTimeAsync(WELCOME_EMAIL_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(send).resolves.toBe(false);
    expect(signal.aborted).toBe(true);
  });

  it('forwards a stable Resend idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendWelcomeEmail({
      email: 'buyer@example.com',
      pwaUrl: 'https://app.example.com',
      locale: 'lt',
      idempotencyKey: 'welcome:order-1',
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': 'welcome:order-1',
        }),
      }),
    );
  });

  it.each([
    [400, 'definite_failure'],
    [408, 'ambiguous'],
    [409, 'ambiguous'],
    [500, 'ambiguous'],
  ] as const)('classifies Resend HTTP %s as %s', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rejected', { status })));

    await expect(sendPreparedWelcomeEmailDetailed({
      resendApiKey: 'resend-test-key',
      message: {
        from: 'Acme <no-reply@example.com>',
        to: 'buyer@example.com',
        subject: 'Welcome',
        html: '<p>Welcome</p>',
      },
      idempotencyKey: 'welcome:order-1',
    })).resolves.toMatchObject({ status: expected });
  });
});
