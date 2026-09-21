import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  session: {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    email: 'buyer@example.com',
    visitor_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    quiz_variant: 'boilerplate-v1',
    funnel_variant: 'main-v1',
    locale: 'en',
    source: 'advertorial',
    client_context: {
      device_type: 'mobile',
      browser: 'Safari',
      platform: 'iOS',
      browser_language: 'lt-LT',
      country: 'LT',
      region: 'VL',
      city: 'Vilnius',
      timezone: 'Europe/Vilnius',
    },
    attribution: {
      first_touch: { utm_source: 'facebook', utm_campaign: 'summer' },
      last_touch: { utm_source: 'facebook', utm_campaign: 'retargeting' },
      fbc: 'fb.1.1789113600000.click-1',
      fbp: 'fb.1.1789113600000.browser-1',
    },
  } as {
    id: string;
    email: string | null;
    visitor_id?: string | null;
    quiz_variant: string | null;
    funnel_variant: string | null;
    locale: string | null;
    source?: string | null;
    attribution: Record<string, unknown> | null;
    client_context?: Record<string, unknown> | null;
  } | null,
  sessionError: null as { message: string } | null,
  order: {
    session_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    amount_cents: 1300,
    currency: 'eur',
    product_slug: 'trial3',
    status: 'trialing',
  } as {
    session_id: string;
    amount_cents: number;
    currency: string;
    product_slug: string | null;
    status: string;
    solidgate_subscription_id?: string | null;
  } | null,
  orderError: null as { message: string } | null,
  claimed: true,
  claimError: null as { message: string } | null,
  rpc: vi.fn(),
  deleteEq: vi.fn(),
  verifyPaymentCookie: vi.fn(),
  sendMetaCapiEvent: vi.fn(),
  hashMetaEmail: vi.fn((email: string) => `hashed:${email}`),
  hashMetaExternalId: vi.fn((id: string) => `hashed-id:${id}`),
  hashMetaCountry: vi.fn((country: string) => `hashed-country:${country}`),
}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table === 'sessions' || table === 'orders') {
        const chain = {
          select: vi.fn(),
          eq: vi.fn(),
          maybeSingle: vi.fn(async () =>
            table === 'sessions'
              ? { data: mocks.session, error: mocks.sessionError }
              : { data: mocks.order, error: mocks.orderError },
          ),
        };
        chain.select.mockReturnValue(chain);
        chain.eq.mockReturnValue(chain);
        return chain;
      }
      if (table === 'meta_capi_event_claims') {
        const chain = { delete: vi.fn(), eq: mocks.deleteEq };
        chain.delete.mockReturnValue(chain);
        mocks.deleteEq.mockReturnValue(chain);
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: mocks.rpc,
  }),
}));

vi.mock('@repo/shared/payment-cookie', () => ({
  PAYMENT_COOKIE_NAME: 'payment_access',
  verifyPaymentCookie: mocks.verifyPaymentCookie,
}));

vi.mock('@/features/analytics/lib/meta-capi', () => ({
  sendMetaCapiEvent: mocks.sendMetaCapiEvent,
  hashMetaEmail: mocks.hashMetaEmail,
  hashMetaExternalId: mocks.hashMetaExternalId,
  hashMetaCountry: mocks.hashMetaCountry,
}));

import { POST } from './route';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function makeRequest(
  body: Record<string, unknown>,
  options: { origin?: string; paymentCookie?: boolean } = {},
) {
  const origin = options.origin ?? 'https://funnel.example';
  const cookies: string[] = [];
  if (options.paymentCookie) cookies.push('payment_access=signed-payment-cookie');
  return new NextRequest('https://funnel.example/api/meta/capi', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'x-forwarded-for': '203.0.113.10',
      cookie: cookies.filter(Boolean).join('; '),
      'user-agent': 'vitest',
    },
    body: JSON.stringify(body),
  });
}

function leadBody() {
  return {
    eventName: 'Lead',
    eventId: 'lead:3fa85f64-5717-4562-b3fc-2c963f66afa6',
    sessionId: SESSION_ID,
    eventSourceUrl: 'https://funnel.example/lt/quiz',
  };
}

describe('Meta CAPI ingress guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYMENT_COOKIE_SECRET = 'test-secret';
    process.env.VERCEL_ENV = 'production';
    process.env.NEXT_PUBLIC_FUNNEL_URL = 'https://funnel.example';
    process.env.META_CAPI_ACCESS_TOKEN = 'test-token';
    process.env.META_PIXEL_ID = 'test-pixel';
    mocks.session = {
      id: SESSION_ID,
      email: 'buyer@example.com',
      visitor_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      quiz_variant: 'boilerplate-v1',
      funnel_variant: 'main-v1',
      locale: 'en',
      source: 'advertorial',
      client_context: {
        device_type: 'mobile',
        browser: 'Safari',
        platform: 'iOS',
        browser_language: 'lt-LT',
        country: 'LT',
        region: 'VL',
        city: 'Vilnius',
        timezone: 'Europe/Vilnius',
      },
      attribution: {
        first_touch: { utm_source: 'facebook', utm_campaign: 'summer' },
        last_touch: { utm_source: 'facebook', utm_campaign: 'retargeting' },
        fbc: 'fb.1.1789113600000.click-1',
        fbp: 'fb.1.1789113600000.browser-1',
      },
    };
    mocks.sessionError = null;
    mocks.order = {
      session_id: SESSION_ID,
      amount_cents: 1300,
      currency: 'eur',
      product_slug: 'trial3',
      status: 'trialing',
    };
    mocks.orderError = null;
    mocks.claimed = true;
    mocks.claimError = null;
    mocks.rpc.mockImplementation(async () => ({ data: mocks.claimed, error: mocks.claimError }));
    mocks.sendMetaCapiEvent.mockResolvedValue(true);
    mocks.verifyPaymentCookie.mockResolvedValue({ sessionId: SESSION_ID });
  });

  it('rejects a cross-origin browser call', async () => {
    const response = await POST(makeRequest(leadBody(), { origin: 'https://attacker.example' }));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('is a quiet no-op when the copied boilerplate has no Meta credentials', async () => {
    delete process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_PIXEL_ID;
    const response = await POST(makeRequest(leadBody()));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      accepted: false,
      configured: false,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary event name', async () => {
    const response = await POST(makeRequest({ ...leadBody(), eventName: 'CustomFraudulentRevenue' }));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('binds a Lead event to a real session and uses the persisted email', async () => {
    const response = await POST(makeRequest({ ...leadBody(), email: 'attacker@example.com' }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      'claim_meta_capi_event',
      expect.objectContaining({
        p_environment: 'production',
        p_event_name: 'Lead',
        p_session_id: SESSION_ID,
      }),
    );
    expect(mocks.hashMetaEmail).toHaveBeenCalledWith('buyer@example.com');
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'Lead',
        userData: expect.objectContaining({
          em: 'hashed:buyer@example.com',
          external_id: 'hashed-id:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          fbc: 'fb.1.1789113600000.click-1',
          fbp: 'fb.1.1789113600000.browser-1',
          country: 'hashed-country:LT',
        }),
        customData: expect.objectContaining({
          quiz_variant: 'boilerplate-v1',
          funnel_variant: 'main-v1',
          locale: 'en',
          source: 'advertorial',
          utm_source: 'facebook',
          utm_campaign: 'summer',
          last_touch_utm_campaign: 'retargeting',
          device_type: 'mobile',
          browser: 'Safari',
          platform: 'iOS',
          browser_language: 'lt-LT',
          country: 'LT',
          city: 'Vilnius',
        }),
      }),
    );
  });

  it('accepts safe quiz progress context and drops arbitrary answer data', async () => {
    const response = await POST(
      makeRequest({
        eventName: 'QuizStepCompleted',
        eventId: 'quiz-step:12345678',
        sessionId: SESSION_ID,
        customData: {
          step_number: 4,
          content_category: 'quiz',
          answers: { health: 'private' },
          result_segment: 'private-profile',
        },
      }),
    );

    expect(response.status).toBe(200);
    const sent = mocks.sendMetaCapiEvent.mock.calls[0]?.[0];
    expect(sent.customData).toMatchObject({
      step_number: 4,
      content_category: 'quiz',
      quiz_variant: 'boilerplate-v1',
      funnel_variant: 'main-v1',
      locale: 'en',
    });
    expect(sent.customData).not.toHaveProperty('answers');
    expect(sent.customData).not.toHaveProperty('result_segment');
  });

  it('strips sensitive URL parameters and does not forward malformed Meta cookies', async () => {
    mocks.session = {
      id: SESSION_ID,
      email: 'buyer@example.com',
      quiz_variant: 'boilerplate-v1',
      funnel_variant: 'main-v1',
      locale: 'en',
      attribution: {
        first_touch: { utm_source: 'facebook' },
        last_touch: { utm_source: 'facebook' },
        fbc: 'malformed-click-cookie',
        fbp: 'malformed-browser-cookie',
      },
    };
    const response = await POST(
      makeRequest({
        ...leadBody(),
        eventSourceUrl:
          'https://funnel.example/en/quiz?utm_campaign=summer&sg_order=secret-order&token=secret-token',
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventSourceUrl: 'https://funnel.example/en/quiz?utm_campaign=summer',
        userData: expect.objectContaining({ fbc: undefined, fbp: undefined }),
      }),
    );
  });

  it('takes Purchase revenue only from a confirmed order', async () => {
    const orderId = `${SESSION_ID}:trial3:2`;
    const response = await POST(
      makeRequest(
        {
          eventName: 'Purchase',
          eventId: `purchase:${orderId}`,
          sessionId: SESSION_ID,
          customData: { value: 999999, currency: 'USD', content_ids: ['fake'] },
        },
        { paymentCookie: true },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        customData: expect.objectContaining({
          value: 13,
          currency: 'EUR',
          content_ids: ['trial3'],
          content_type: 'product',
        }),
      }),
    );
  });

  it('keeps zero-decimal JPY purchase revenue in whole yen', async () => {
    mocks.order = {
      session_id: SESSION_ID,
      amount_cents: 18335,
      currency: 'jpy',
      product_slug: 'oto1_lifetime',
      status: 'completed',
    };
    const orderId = `${SESSION_ID}:oto1_lifetime:1`;

    const response = await POST(
      makeRequest(
        {
          eventName: 'Purchase',
          eventId: `purchase:${orderId}`,
          sessionId: SESSION_ID,
          customData: { value: 183.35, currency: 'JPY', content_ids: ['fake'] },
        },
        { paymentCookie: true },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        customData: expect.objectContaining({
          value: 18335,
          currency: 'JPY',
          content_ids: ['oto1_lifetime'],
          content_type: 'product',
        }),
      }),
    );
  });

  it('accepts StartTrial only for a genuine zero-amount subscription order', async () => {
    mocks.order = {
      session_id: SESSION_ID,
      amount_cents: 0,
      currency: 'eur',
      product_slug: 'special_free',
      status: 'trialing',
      solidgate_subscription_id: 'sub-1',
    };
    const orderId = `${SESSION_ID}:special_free:1`;

    const response = await POST(
      makeRequest(
        {
          eventName: 'StartTrial',
          eventId: `purchase:${orderId}`,
          sessionId: SESSION_ID,
          customData: { value: 999, currency: 'USD' },
        },
        { paymentCookie: true },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'StartTrial',
        customData: expect.objectContaining({
          value: 0,
          currency: 'EUR',
          content_ids: ['special_free'],
          content_type: 'product',
        }),
      }),
    );
  });

  it('rejects StartTrial when the order was actually a paid charge', async () => {
    const orderId = `${SESSION_ID}:trial3:2`;
    const response = await POST(
      makeRequest(
        { eventName: 'StartTrial', eventId: `purchase:${orderId}`, sessionId: SESSION_ID },
        { paymentCookie: true },
      ),
    );
    expect(response.status).toBe(403);
    expect(mocks.sendMetaCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects Purchase without payment access', async () => {
    mocks.verifyPaymentCookie.mockResolvedValue(null);
    const orderId = `${SESSION_ID}:trial3:2`;
    const response = await POST(
      makeRequest({ eventName: 'Purchase', eventId: `purchase:${orderId}`, sessionId: SESSION_ID }),
    );
    expect(response.status).toBe(403);
    expect(mocks.sendMetaCapiEvent).not.toHaveBeenCalled();
  });

  it('silently deduplicates or throttles a rejected claim', async () => {
    mocks.claimed = false;
    const response = await POST(makeRequest(leadBody()));
    expect(response.status).toBe(202);
    expect(mocks.sendMetaCapiEvent).not.toHaveBeenCalled();
  });

  it('retries Meta once and releases the claim after a persistent failure', async () => {
    mocks.sendMetaCapiEvent.mockResolvedValue(false);
    const response = await POST(makeRequest(leadBody()));

    expect(response.status).toBe(503);
    expect(mocks.sendMetaCapiEvent).toHaveBeenCalledTimes(2);
    expect(mocks.deleteEq).toHaveBeenCalledWith('event_id', leadBody().eventId);
  });
});
