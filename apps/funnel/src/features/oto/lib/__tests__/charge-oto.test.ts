import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chargeOtoSolidgate,
  clearSolidgateConfirmOrigin,
  isCurrentSolidgateConfirmOrigin,
  OTO_CHARGE_REQUEST_TIMEOUT_MS,
  otoLifecycleEventProperties,
  otoPurchaseEventProperties,
  readSolidgateConfirmOrigin,
  resumeSolidgateOto,
} from '../charge-oto';
import {
  clearAcceptedOtoRecoveryMemoryForTests,
  readAcceptedOtoRecoveryOrders,
} from '../accepted-oto-recovery';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ORDER_ID = `${SESSION_ID}:oto3_bundle_all:1`;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('Solidgate OTO client result', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    clearAcceptedOtoRecoveryMemoryForTests();
    window.history.replaceState({}, '', '/oto/3?utm_source=fb&utm_campaign=campaign-a&gclid=g-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not turn a 202 charge into a successful purchase', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        ok: false,
        pending: true,
        orderId: 'session:oto3:1',
        amountCents: 3_000,
        currency: 'eur',
        productSlug: 'oto3_bundle_all',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcomePromise = chargeOtoSolidgate({ slug: 'oto3_bundle_all', sessionId: 'session' });
    await vi.runAllTimersAsync();
    await expect(outcomePromise).resolves.toMatchObject({ ok: false, pending: true });
  });

  it('bounds an ambiguous initial request and reports pending instead of decline', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(requestSignal?.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }));
    const onPending = vi.fn();

    const outcome = chargeOtoSolidgate({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      onPending,
    });
    await vi.advanceTimersByTimeAsync(OTO_CHARGE_REQUEST_TIMEOUT_MS);

    await expect(outcome).resolves.toEqual({ ok: false, pending: true });
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never issues a second request after an accepted 202 handoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        ok: false,
        pending: true,
        accepted: true,
        orderId: ORDER_ID,
        amountCents: 3_000,
        currency: 'eur',
        productSlug: 'oto3_bundle_all',
        lastOtoStep: '6',
        resumeTo: '/oto/6',
        nextOto: '/oto/6',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chargeOtoSolidgate({ slug: 'oto3_bundle_all', sessionId: SESSION_ID }),
    ).resolves.toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      lastOtoStep: '6',
      resumeTo: '/oto/6',
      nextOto: '/oto/6',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('confirmOrderId');
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBeNull();
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([
      expect.objectContaining({ orderId: ORDER_ID, productSlug: 'oto3_bundle_all' }),
    ]);
  });

  it('returns an accepted 3DS handoff without mutating its history entry', async () => {
    window.history.replaceState({}, '', `/oto/3?sg_confirm=${encodeURIComponent(ORDER_ID)}`);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        ok: false,
        pending: true,
        accepted: true,
        orderId: ORDER_ID,
        amountCents: 3_000,
        currency: 'eur',
        productSlug: 'oto3_bundle_all',
        lastOtoStep: '6',
        resumeTo: '/oto/6',
        nextOto: '/oto/6',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await resumeSolidgateOto({
      slug: 'oto3_bundle_all',
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
    });
    expect(outcome).toMatchObject({
      ok: false,
      pending: true,
      accepted: true,
      lastOtoStep: '6',
      resumeTo: '/oto/6',
      nextOto: '/oto/6',
    });
    expect(outcome).not.toHaveProperty('tracking');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(
      ORDER_ID,
    );
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([
      expect.objectContaining({ orderId: ORDER_ID, productSlug: 'oto3_bundle_all' }),
    ]);
  });

  it('does not turn a pending 3DS confirmation into a successful purchase', async () => {
    window.history.replaceState({}, '', '/oto/3?sg_confirm=session%3Aoto3%3A1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(202, {
          ok: false,
          pending: true,
          orderId: 'session:oto3:1',
        }),
      ),
    );

    const outcome = resumeSolidgateOto({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      orderId: 'session:oto3:1',
    });
    await expect(outcome).resolves.toMatchObject({ ok: false, pending: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(
      'session:oto3:1',
    );
  });

  it('reports an unaccepted initial handoff exactly once without a confirmation loop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(202, {
          ok: false,
          pending: true,
          orderId: 'session:oto3:1',
        }),
      ),
    );
    const onPending = vi.fn();

    const outcomePromise = chargeOtoSolidgate({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      onPending,
    });
    await expect(outcomePromise).resolves.toMatchObject({ ok: false, pending: true });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBeNull();
  });

  it('treats a transient 500 as indeterminate and leaves the origin marker intact', async () => {
    window.history.replaceState({}, '', '/oto/3?sg_confirm=session%3Aoto3%3A1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { error: 'Solidgate /status responded 429' })),
    );

    const outcomePromise = resumeSolidgateOto({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      orderId: 'session:oto3:1',
    });
    await expect(outcomePromise).resolves.toMatchObject({ ok: false, pending: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe('session:oto3:1');
  });

  it('leaves history ownership to the hook on a definitive decline', async () => {
    window.history.replaceState({}, '', '/oto/3?sg_confirm=session%3Aoto3%3A1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(402, { error: 'Payment declined', code: '3.02' })),
    );

    const outcomePromise = resumeSolidgateOto({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      orderId: 'session:oto3:1',
    });
    await expect(outcomePromise).resolves.toMatchObject({ ok: false, error: 'Payment declined' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(
      'session:oto3:1',
    );
  });

  it('clears only the matching origin marker and preserves framework history state', () => {
    const frameworkState = { __NA: true, tree: ['oto', '3'] };
    window.history.replaceState(
      frameworkState,
      '',
      '/oto/3?campaign=x&sg_confirm=session%3Aoto3%3A1#details',
    );
    const origin = readSolidgateConfirmOrigin();
    expect(origin).not.toBeNull();
    expect(isCurrentSolidgateConfirmOrigin(origin!)).toBe(true);

    window.history.replaceState(
      { __NA: true, tree: ['oto', '4'] },
      '',
      '/oto/4?sg_confirm=session%3Aoto4%3AB',
    );
    expect(clearSolidgateConfirmOrigin(origin!)).toBe(false);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(
      'session:oto4:B',
    );

    window.history.replaceState(frameworkState, '', origin!.href);
    expect(clearSolidgateConfirmOrigin(origin!)).toBe(true);
    expect(window.history.state).toEqual(frameworkState);
    expect(window.location.pathname).toBe('/oto/3');
    expect(window.location.hash).toBe('#details');
    expect(new URL(window.location.href).searchParams.get('campaign')).toBe('x');
    expect(new URL(window.location.href).searchParams.has('sg_confirm')).toBe(false);
  });

  it('recognises capture on the single 3DS return confirmation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
          jsonResponse(200, {
            ok: true,
            orderId: 'session:oto3:1',
            amountCents: 3_000,
            currency: 'eur',
            productSlug: 'oto3_bundle_all',
            tracking: {
              payment_provider: 'solidgate',
              billing_type: 'one_time',
              surface: 'funnel',
              funnel_code: 'BRAND',
              funnel_variant: 'oto3',
              product: 'oto3_bundle_all',
              product_id: 'BRANDBUNDLE_000000_PDF',
              product_code: 'BRANDBUNDLE_000000_PDF',
              product_name: 'Ultimate Insight Pack',
              product_slug: 'oto3_bundle_all',
              price_id: null,
              solidgate_product_id: null,
              solidgate_price_id: null,
              amount_cents: 3_000,
              currency: 'EUR',
            },
          }),
        ),
    );

    const outcomePromise = resumeSolidgateOto({
      slug: 'oto3_bundle_all',
      sessionId: 'session',
      orderId: 'session:oto3:1',
    });
    await expect(outcomePromise).resolves.toMatchObject({
      ok: true,
      tracking: { event_id: 'purchase:session:oto3:1' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports success only for the final ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          orderId: 'session:oto3:1',
          amountCents: 3_000,
          currency: 'eur',
          productSlug: 'oto3_bundle_all',
          tracking: {
            payment_provider: 'solidgate',
            billing_type: 'one_time',
            surface: 'funnel',
            funnel_code: 'BRAND',
            funnel_variant: 'oto3',
            product: 'oto3_bundle_all',
            product_id: 'BRANDBUNDLE_000000_PDF',
            product_code: 'BRANDBUNDLE_000000_PDF',
            product_name: 'Ultimate Insight Pack',
            product_slug: 'oto3_bundle_all',
            price_id: null,
            solidgate_product_id: null,
            solidgate_price_id: null,
            amount_cents: 3_000,
            currency: 'EUR',
          },
        }),
      ),
    );

    const outcome = await chargeOtoSolidgate({ slug: 'oto3_bundle_all', sessionId: 'session' });
    expect(outcome).toMatchObject({
      ok: true,
      orderId: 'session:oto3:1',
      amountCents: 3_000,
      tracking: {
        transaction_id: 'session:oto3:1',
        event_id: 'purchase:session:oto3:1',
        $insert_id: 'purchase:session:oto3:1',
        product_id: 'BRANDBUNDLE_000000_PDF',
        product_slug: 'oto3_bundle_all',
        utm_source: 'fb',
        gclid: 'g-1',
      },
    });

    expect(otoPurchaseEventProperties(outcome, 'session')).toMatchObject({
      session_id: 'session',
      transaction_id: 'session:oto3:1',
      product_name: 'Ultimate Insight Pack',
      amount_cents: 3_000,
      value: 30,
      currency: 'EUR',
    });
    expect(otoLifecycleEventProperties(outcome, 'session', 'oto3_purchased')).toMatchObject({
      event_id: 'oto3_purchased:session:oto3:1',
      $insert_id: 'oto3_purchased:session:oto3:1',
    });

    const request = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(requestBody.attribution).toMatchObject({
      first_touch: { utm_source: 'fb', utm_campaign: 'campaign-a', gclid: 'g-1' },
    });
    expect(requestBody.returnUrl).toBe(
      'http://localhost:3000/oto/3?utm_source=fb&utm_campaign=campaign-a&gclid=g-1',
    );
  });
});
