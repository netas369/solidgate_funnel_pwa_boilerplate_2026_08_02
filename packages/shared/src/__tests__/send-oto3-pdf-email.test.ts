import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sendPreparedOto3PdfEmailDetailed,
  type PreparedOto3PdfEmail,
} from '../email/send-oto3-pdf-email';

const MESSAGE: PreparedOto3PdfEmail = {
  from: 'Acme <delivery@example.com>',
  to: 'buyer@example.com',
  subject: 'Your report',
  html: '<p>Stable report body</p>',
};

function send() {
  return sendPreparedOto3PdfEmailDetailed({
    resendApiKey: 'resend-test-key',
    idempotencyKey: 'oto-pdf-order-123',
    message: MESSAGE,
  });
}

describe('sendPreparedOto3PdfEmailDetailed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the persisted message with the stable idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(send()).resolves.toEqual({ status: 'sent' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'oto-pdf-order-123' }),
        body: JSON.stringify(MESSAGE),
      }),
    );
  });

  it.each([500, 502, 503])('classifies Resend HTTP %i as ambiguous', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('provider failure', { status })),
    );

    await expect(send()).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('classifies a concurrent idempotency-key 409 as ambiguous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 409,
            name: 'concurrent_idempotent_requests',
            message: 'Another request with the same idempotency key is still processing',
          }),
          { status: 409 },
        ),
      ),
    );

    await expect(send()).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('fails closed for an unrecognized 409 response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('conflict', { status: 409 })),
    );

    await expect(send()).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('keeps an invalid-idempotency 409 ambiguous because the prior body may have sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: 'invalid_idempotent_request' }), { status: 409 }),
      ),
    );

    await expect(send()).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it.each([400, 401, 403, 422, 429])(
    'classifies known no-send HTTP %i as definite failure',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('request rejected', { status })),
      );

      await expect(send()).resolves.toMatchObject({ status: 'definite_failure' });
    },
  );

  it('classifies an HTTP timeout response as ambiguous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('request timeout', { status: 408 })),
    );

    await expect(send()).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('classifies a transport failure as ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));

    await expect(send()).resolves.toEqual({ status: 'ambiguous', error: 'socket closed' });
  });
});
