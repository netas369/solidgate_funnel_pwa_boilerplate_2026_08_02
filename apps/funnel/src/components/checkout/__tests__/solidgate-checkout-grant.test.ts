import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const sdk = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@solidgate/react-sdk', () => ({
  default: (props: Record<string, unknown>) => {
    sdk.props = props;
    return null;
  },
  SdkLoader: { load: vi.fn() },
}));

import { act, render, screen, waitFor } from '@testing-library/react';
import {
  CHECKOUT_OPEN_TIMEOUT_MS,
  confirmSettledGrant,
  GRANT_POLL_BUDGET_MS,
  SolidgateCheckout,
  SUBMIT_OUTCOME_TIMEOUT_MS,
  TerminalPaymentError,
} from '../solidgate-checkout';

const ORDER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6:trial3:1';
const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TRACKING = {
  payment_provider: 'solidgate',
  billing_type: 'subscription_initial',
  surface: 'funnel',
  funnel_code: 'BRAND',
  funnel_variant: 'main',
  product: 'trial3',
  product_id: 'BRAND_000000_SUB',
  product_code: 'BRAND_000000_SUB',
  product_name: 'Main Subscription',
  product_slug: 'trial3',
  price_id: 'price-1',
  solidgate_product_id: 'product-1',
  solidgate_price_id: 'price-1',
  amount_cents: 1300,
  currency: 'EUR',
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('confirmSettledGrant', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('polls a pending authorization and resolves only after capture', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, pending: true, status: 'auth_ok' }, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, settled: true, status: 'settle_ok' }, 200));
    vi.stubGlobal('fetch', fetchMock);

    const confirmation = confirmSettledGrant(ORDER_ID, SESSION_ID, 1300);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(confirmation).resolves.toMatchObject({ settled: true, status: 'settle_ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hands off an explicitly accepted paid authorization once, then keeps reconciling to capture', async () => {
    const accepted = {
      ok: false,
      pending: true,
      accepted: true,
      authorized: true,
      orderId: ORDER_ID,
      status: 'auth_ok',
      resumeTo: `/oto/1?sg_main=${encodeURIComponent(ORDER_ID)}`,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(accepted, 202))
      .mockResolvedValueOnce(jsonResponse(accepted, 202))
      .mockResolvedValueOnce(jsonResponse({ ok: true, captured: true, status: 'settle_ok' }, 200));
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);

    const confirmation = confirmSettledGrant(
      ORDER_ID,
      SESSION_ID,
      1300,
      undefined,
      onAccepted,
    );
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(confirmation).resolves.toMatchObject({ captured: true, status: 'settle_ok' });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(accepted);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('transfers exact-order polling ownership when the accepted page has durable recovery', async () => {
    const accepted = {
      ok: false,
      pending: true,
      accepted: true,
      authorized: true,
      orderId: ORDER_ID,
      status: 'auth_ok',
      resumeTo: `/oto/1?sg_main=${encodeURIComponent(ORDER_ID)}`,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(accepted, 202));
    const onAccepted = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmSettledGrant(
      ORDER_ID,
      SESSION_ID,
      1300,
      undefined,
      onAccepted,
    )).resolves.toEqual(accepted);
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accepts an explicitly authorized zero-amount subscription trial', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, authorizedTrial: true, status: 'auth_ok' }, 200),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(confirmSettledGrant(ORDER_ID, SESSION_ID, 0)).resolves.toMatchObject({
      authorizedTrial: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact partial settlement through the unified captured flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, captured: true, settled: true, status: 'partial_settled' }, 200),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmSettledGrant(ORDER_ID, SESSION_ID, 1300)).resolves.toMatchObject({
      captured: true,
      status: 'partial_settled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The budget is a wall-clock deadline, not an attempt count. A fixed count
   * silently drifted: with the grant route's own retry loop inside every
   * request, "20 attempts × 2s" really spent ~160s, so the promise the code
   * documented was not the one the buyer experienced.
   */
  it('never accepts paid auth_ok as a Purchase, and honours the settle budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, settled: false, status: 'auth_ok' }, 200),
    );
    vi.stubGlobal('fetch', fetchMock);
    const confirmation = confirmSettledGrant(ORDER_ID, SESSION_ID, 1300);
    const rejection = expect(confirmation).rejects.toThrow('payment_pending');

    // Still polling well past the old 40s ceiling: a slow issuer must never
    // read as a decline to a buyer whose card is already charged.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(15);
    expect(confirmation).toBeInstanceOf(Promise);

    await vi.advanceTimersByTimeAsync(GRANT_POLL_BUDGET_MS);
    await rejection;
  });

  it('turns a hung network into same-order payment_pending at the deadline', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const confirmation = confirmSettledGrant(ORDER_ID, SESSION_ID, 1300);
    const rejection = expect(confirmation).rejects.toThrow('payment_pending');

    await vi.advanceTimersByTimeAsync(GRANT_POLL_BUDGET_MS + 1);
    await rejection;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).toEqual({
        orderId: ORDER_ID,
        sessionId: SESSION_ID,
      });
    }
  });

  it('keeps the request timeout armed while a response body is stalled', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const confirmation = confirmSettledGrant(ORDER_ID, SESSION_ID, 1300);
    const rejection = expect(confirmation).rejects.toThrow('payment_pending');

    await vi.advanceTimersByTimeAsync(GRANT_POLL_BUDGET_MS + 1);
    await rejection;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops immediately on a terminal void/failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, code: 'void_ok', error: 'Authorization voided' }, 402),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(confirmSettledGrant(ORDER_ID, SESSION_ID, 1300)).rejects.toThrow('void_ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only marks a failure retryable when the API binds an explicit terminal status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        terminal: true,
        retryable: true,
        orderId: ORDER_ID,
        status: 'declined',
        code: 'payment_failed',
      }, 402),
    );
    vi.stubGlobal('fetch', fetchMock);

    const failure = await confirmSettledGrant(ORDER_ID, SESSION_ID, 1300).catch((error) => error);
    expect(failure).toBeInstanceOf(TerminalPaymentError);
    expect(failure).toMatchObject({ orderId: ORDER_ID, providerStatus: 'declined' });
  });
});

describe('SolidgateCheckout terminal retry', () => {
  beforeEach(() => {
    sdk.props = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enables Apple Pay through the cross-browser JS integration', async () => {
    const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200),
    ));

    render(createElement(SolidgateCheckout, {
      productId: 'trial3',
      sessionId: SESSION_ID,
      price: '€13',
      buttonText: 'Pay',
      intent: true,
      onSuccess: vi.fn(),
    }));

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData));
    expect(sdk.props?.applePayButtonParams).toEqual({ enabled: true, integrationType: 'js' });
    expect(sdk.props?.googlePayButtonParams).toEqual({ enabled: false });
  });

  it('shows processing feedback on submit and reveals an interactive 3DS challenge', async () => {
    const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200),
    ));

    render(createElement(SolidgateCheckout, {
      productId: 'trial3',
      sessionId: SESSION_ID,
      price: '€13',
      buttonText: 'Pay',
      intent: true,
      processingLabel: 'Payment processing',
      grantingNotice: 'Confirming payment. Do not close this page.',
      onSuccess: vi.fn(),
    }));

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData));
    act(() => {
      (sdk.props?.onMounted as () => void)();
    });
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();

    act(() => {
      (sdk.props?.onSubmit as () => void)();
    });
    const processingStatus = screen.getByRole('status');
    expect(processingStatus).toHaveTextContent('Payment processing');
    expect(processingStatus).toHaveTextContent(
      'Confirming payment. Do not close this page.',
    );
    expect(processingStatus).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('Confirming payment. Do not close this page.'))
      .not.toHaveAttribute('aria-hidden');
    const formWrapper = document.querySelector('[inert]');
    expect(formWrapper).toHaveAttribute('aria-busy', 'true');
    expect(formWrapper).toHaveStyle({ opacity: '0.6', pointerEvents: 'none' });

    act(() => {
      (sdk.props?.onVerify as () => void)();
    });
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(screen.getByText('Confirming payment. Do not close this page.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(formWrapper).toHaveAttribute('aria-busy', 'false');
    expect(formWrapper).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });
  });

  it('reconciles the exact order when the SDK drops every post-submit outcome event', async () => {
    vi.useFakeTimers();
    try {
      const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
      const onSuccess = vi.fn();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200),
        )
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, captured: true, status: 'settle_ok' }, 200),
        );
      vi.stubGlobal('fetch', fetchMock);

      render(createElement(SolidgateCheckout, {
        productId: 'trial3',
        sessionId: SESSION_ID,
        price: '€13',
        buttonText: 'Pay',
        intent: true,
        processingLabel: 'Payment processing',
        onSuccess,
      }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sdk.props?.merchantData).toEqual(merchantData);
      act(() => {
        (sdk.props?.onMounted as () => void)();
        (sdk.props?.onSubmit as () => void)();
      });
      expect(screen.getByRole('status')).toHaveTextContent('Payment processing');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBMIT_OUTCOME_TIMEOUT_MS);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        orderId: ORDER_ID,
        sessionId: SESSION_ID,
      });
      expect(onSuccess).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the durable pending notice visible during background exact-order rechecks', async () => {
    vi.useFakeTimers();
    try {
      const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
      const pending = {
        ok: false,
        pending: true,
        orderId: ORDER_ID,
        status: 'processing',
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200),
        )
        .mockResolvedValue(jsonResponse(pending, 202));
      vi.stubGlobal('fetch', fetchMock);

      render(createElement(SolidgateCheckout, {
        productId: 'trial3',
        sessionId: SESSION_ID,
        price: '€13',
        buttonText: 'Pay',
        intent: true,
        processingLabel: 'Payment processing',
        pendingNotice: 'Payment pending',
        onSuccess: vi.fn(),
      }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        (sdk.props?.onMounted as () => void)();
        (sdk.props?.onSubmit as () => void)();
        (sdk.props?.onError as () => void)();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(GRANT_POLL_BUDGET_MS + 1);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Payment pending');
      expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Payment pending');
      expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
      expect(document.querySelector('[inert]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the processing overlay visible while accepted payment navigation takes ownership', async () => {
    const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
    const accepted = {
      ok: false,
      pending: true,
      accepted: true,
      authorized: true,
      orderId: ORDER_ID,
      status: 'auth_ok',
      resumeTo: `/oto/1?sg_main=${encodeURIComponent(ORDER_ID)}`,
    };
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200),
      )
      .mockResolvedValueOnce(jsonResponse(accepted, 202)));
    const onAccepted = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    render(createElement(SolidgateCheckout, {
      productId: 'trial3',
      sessionId: SESSION_ID,
      price: '€13',
      buttonText: 'Pay',
      intent: true,
      processingLabel: 'Payment processing',
      grantingNotice: 'Confirming payment. Do not close this page.',
      onAccepted,
      onSuccess,
    }));

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData));
    act(() => {
      (sdk.props?.onMounted as () => void)();
      (sdk.props?.onSubmit as () => void)();
      (sdk.props?.onSuccess as (event: { order?: { subscription_id?: string } }) => void)({
        order: { subscription_id: 'subscription-1' },
      });
    });

    await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toHaveTextContent('Payment processing');
    expect(document.querySelector('[inert]')).not.toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('reconciles SDK fail and opens exactly one different N+1 order', async () => {
    const nextOrderId = `${SESSION_ID}:trial3:2`;
    const merchantData1 = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
    const merchantData2 = { merchant: 'merchant', paymentIntent: 'intent-2', signature: 'sig-2' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ merchantData: merchantData1, orderId: ORDER_ID, tracking: TRACKING }, 200))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        terminal: true,
        retryable: true,
        orderId: ORDER_ID,
        status: 'declined',
        code: 'payment_failed',
      }, 402))
      .mockResolvedValueOnce(jsonResponse({ merchantData: merchantData2, orderId: nextOrderId, tracking: TRACKING }, 200));
    vi.stubGlobal('fetch', fetchMock);

    render(
      createElement(SolidgateCheckout, {
        productId: 'trial3',
        sessionId: SESSION_ID,
        price: '€13',
        buttonText: 'Pay',
        intent: true,
        pendingNotice: 'Payment pending',
        processingLabel: 'Payment processing',
        grantingNotice: 'Confirming payment',
        onSuccess: vi.fn(),
      }),
    );

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData1));
    act(() => {
      (sdk.props?.onMounted as () => void)();
      (sdk.props?.onSubmit as () => void)();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Payment processing');

    const onFail = sdk.props?.onFail as ((event: { code?: string; message?: string }) => void);
    act(() => {
      onFail({ code: '3.02', message: 'Declined' });
      onFail({ code: '3.02', message: 'Duplicate SDK fail' });
    });

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData2));
    expect(screen.queryByText('Payment processing')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      productId: 'trial3',
      sessionId: SESSION_ID,
    });
  });

  it('keeps the original form inert when create-session has not returned a different id', async () => {
    const merchantData = { merchant: 'merchant', paymentIntent: 'intent-1', signature: 'sig-1' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200))
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        terminal: true,
        retryable: true,
        orderId: ORDER_ID,
        status: 'declined',
        code: 'payment_failed',
      }, 402))
      // Atomic checkout open has not observed terminal yet: same id is unsafe.
      .mockResolvedValueOnce(jsonResponse({ merchantData, orderId: ORDER_ID, tracking: TRACKING }, 200));
    vi.stubGlobal('fetch', fetchMock);

    render(createElement(SolidgateCheckout, {
      productId: 'trial3',
      sessionId: SESSION_ID,
      price: '€13',
      buttonText: 'Pay',
      intent: true,
      pendingNotice: 'Payment pending',
      onSuccess: vi.fn(),
    }));

    await waitFor(() => expect(sdk.props?.merchantData).toEqual(merchantData));
    act(() => {
      (sdk.props?.onMounted as () => void)();
      (sdk.props?.onFail as (event: Record<string, never>) => void)({});
    });

    await waitFor(() => expect(screen.getByText('Payment pending')).toHaveAttribute('role', 'status'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sdk.props?.merchantData).toEqual(merchantData);
    expect(document.querySelector('[inert]')).not.toBeNull();
  });
});

describe('SolidgateCheckout order-open deadline', () => {
  beforeEach(() => {
    sdk.props = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderCheckout() {
    render(createElement(SolidgateCheckout, {
      productId: 'trial3',
      sessionId: SESSION_ID,
      price: '€13',
      buttonText: 'Pay',
      intent: true,
      loadingLabel: 'Loading payment form',
      errorMessages: { checkout_unavailable: 'Checkout unavailable' },
      onSuccess: vi.fn(),
    }));
  }

  it('replaces the loader when create-session never returns headers', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderCheckout();
    expect(screen.getByText('Loading payment form')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_OPEN_TIMEOUT_MS + 1);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Checkout unavailable');
    expect(screen.queryByText('Loading payment form')).not.toBeInTheDocument();
  });

  it('keeps the deadline armed while the create-session JSON body is stalled', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCheckout();
    expect(screen.getByText('Loading payment form')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_OPEN_TIMEOUT_MS + 1);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Checkout unavailable');
    expect(screen.queryByText('Loading payment form')).not.toBeInTheDocument();
  });
});
