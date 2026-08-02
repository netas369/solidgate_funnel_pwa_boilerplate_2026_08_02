// Solidgate API client  -  native fetch + Web Crypto signature
//
// Solidgate splits its v1 API across domain hosts; calling the wrong host
// returns a WAF block, not a 404 (https://api-docs.solidgate.com/api/get-started):
//   cards          https://pay.solidgate.com/api/v1/
//   subscriptions  https://subscriptions.solidgate.com/api/v1/
//   APMs           https://gate.solidgate.com/api/v1/
//   reports        https://reports.solidgate.com/api/v1/
//
// There is no idempotency-key mechanism: uniqueness rides on the merchant-
// generated order_id (see order-id.ts). Rate limits: 10 rps sandbox / 25 live,
// HTTP 429 + error code 5.07 on excess.

import { signSolidgatePayload } from './signature';

export const SOLIDGATE_HOSTS = {
  pay: 'https://pay.solidgate.com/api/v1/',
  subscriptions: 'https://subscriptions.solidgate.com/api/v1/',
  gate: 'https://gate.solidgate.com/api/v1/',
  reports: 'https://reports.solidgate.com/api/v1/',
} as const;

export type SolidgateHost = keyof typeof SOLIDGATE_HOSTS;

/**
 * Keep provider calls below both the browser's 15s confirmation request budget
 * and the serverless platform ceiling. A timeout is an indeterminate transport
 * result: callers must reconcile the same merchant order ID, never mint N+1.
 */
export const SOLIDGATE_REQUEST_TIMEOUT_MS = 12_000;

export interface SolidgateKeys {
  publicKey: string;
  secretKey: string;
}

/** Non-2xx transport failure. Solidgate ALSO reports declines inside 2xx
 * bodies as an `error` object  -  callers must check that themselves. */
export class SolidgateApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Solidgate ${path} responded ${status}`);
    this.name = 'SolidgateApiError';
  }
}

export function getSolidgateKeys(): SolidgateKeys {
  const vercelEnvironment = process.env.VERCEL_ENV;
  const expectedSolidgateEnvironment =
    vercelEnvironment === 'production'
      ? 'production'
      : vercelEnvironment === 'preview'
        ? 'sandbox'
        : null;

  // Vercel scopes can hold different values under the same variable names.
  // Bind each deployed scope to an explicit marker so a copied sandbox pair
  // can never silently process live traffic (or vice versa). Local/dev remains
  // optional because it does not represent a deployed payment environment.
  if (
    expectedSolidgateEnvironment &&
    process.env.SOLIDGATE_ENVIRONMENT !== expectedSolidgateEnvironment
  ) {
    throw new Error(
      `SOLIDGATE_ENVIRONMENT must be "${expectedSolidgateEnvironment}" when VERCEL_ENV is "${vercelEnvironment}"`,
    );
  }

  const publicKey = process.env.SOLIDGATE_API_PUBLIC_KEY;
  const secretKey = process.env.SOLIDGATE_API_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error('SOLIDGATE_API_PUBLIC_KEY / SOLIDGATE_API_SECRET_KEY env vars are not set');
  }
  return { publicKey, secretKey };
}

export class SolidgateClient {
  constructor(private readonly keys: SolidgateKeys) {}

  private boundedSignal(signal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });

    const timeout = setTimeout(
      () => controller.abort(new DOMException('Solidgate request timed out', 'TimeoutError')),
      SOLIDGATE_REQUEST_TIMEOUT_MS,
    );

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', relayAbort);
      },
    };
  }

  /** Generic signed POST. All Solidgate v1 operations are POSTs with JSON bodies. */
  async request<T = Record<string, unknown>>(
    host: SolidgateHost,
    path: string,
    attributes: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = JSON.stringify(attributes);
    const bounded = this.boundedSignal(signal);
    try {
      const res = await fetch(`${SOLIDGATE_HOSTS[host]}${path}`, {
        method: 'POST',
        headers: {
          Merchant: this.keys.publicKey,
          Signature: await signSolidgatePayload(this.keys.publicKey, this.keys.secretKey, body),
          'Content-Type': 'application/json',
        },
        body,
        signal: bounded.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new SolidgateApiError(res.status, path, text);
      }
      if (!res.ok) throw new SolidgateApiError(res.status, path, json);
      return json as T;
    } finally {
      // Preserve native AbortError/TimeoutError. Route state machines treat it
      // as ambiguous and reconcile the same order after their lease expires.
      bounded.cleanup();
    }
  }

  /**
   * Signed GET. Body-less requests sign `publicKey + publicKey` (there is no
   * body to sandwich), per docs.solidgate.com/payments/integrate/access-to-api.
   */
  async get<T = Record<string, unknown>>(
    host: SolidgateHost,
    path: string,
    query: Record<string, string | number> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const qs = new URLSearchParams(
      Object.entries(query).map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `${SOLIDGATE_HOSTS[host]}${path}${qs ? `?${qs}` : ''}`;
    const bounded = this.boundedSignal(signal);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Merchant: this.keys.publicKey,
          Signature: await signSolidgatePayload(this.keys.publicKey, this.keys.secretKey, ''),
        },
        signal: bounded.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new SolidgateApiError(res.status, path, text);
      }
      if (!res.ok) throw new SolidgateApiError(res.status, path, json);
      return json as T;
    } finally {
      bounded.cleanup();
    }
  }

  // ── Card API (pay host) ────────────────────────────────────────────────
  /** Order + transactions state; includes transaction.card_token for reuse. */
  status<T = Record<string, unknown>>(
    attributes: { order_id: string },
    signal?: AbortSignal,
  ) {
    return this.request<T>('pay', 'status', attributes, signal);
  }

  /**
   * Token charge  -  the OTO/one-click + rebill workhorse.
   * payment_type: '1-click' = customer-present card/network-token (CIT);
   * 'rebill' = Apple/Google-Pay-derived token per merchant-specific Solidgate
   * Support guidance. Other MIT values include 'recurring', 'retry', and
   * 'installment'. Subscription variant:
   * pass recurring_token + product_id (no amount/currency) to start a new
   * subscription on a saved card.
   */
  recurring<T = Record<string, unknown>>(
    attributes: Record<string, unknown> & { recurring_token: string; payment_type: string },
    signal?: AbortSignal,
  ) {
    return this.request<T>('pay', 'recurring', attributes, signal);
  }

  /** Full or partial refund; amount in minor units, multiple partials allowed. */
  refund<T = Record<string, unknown>>(attributes: {
    order_id: string;
    amount: number;
    refund_reason_code?: string;
  }, signal?: AbortSignal) {
    return this.request<T>('pay', 'refund', attributes, signal);
  }

  // ── Subscriptions API (subscriptions host) ─────────────────────────────
  subscriptionStatus<T = Record<string, unknown>>(
    attributes: { subscription_id: string },
    signal?: AbortSignal,
  ) {
    return this.request<T>('subscriptions', 'subscription/status', attributes, signal);
  }

  /** force: true = cancel now; false = at end of billing period. */
  cancelSubscription(
    attributes: { subscription_id: string; force: boolean; cancel_code?: string },
    signal?: AbortSignal,
  ) {
    return this.request('subscriptions', 'subscription/cancel', attributes, signal);
  }

  restoreSubscription(attributes: { subscription_id: string }, signal?: AbortSignal) {
    return this.request('subscriptions', 'subscription/restore', attributes, signal);
  }

  updateSubscriptionToken(
    attributes: { subscription_id: string; token: string },
    signal?: AbortSignal,
  ) {
    return this.request('subscriptions', 'subscription/update-token', attributes, signal);
  }
}
