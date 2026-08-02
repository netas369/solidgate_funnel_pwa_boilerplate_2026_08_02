import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOLIDGATE_REQUEST_TIMEOUT_MS,
  SolidgateClient,
} from '../solidgate/client';

const KEYS = {
  publicKey: 'api-public',
  secretKey: 'api-secret-that-is-long-enough-for-signing',
};

function abortablePendingFetch(): {
  fetchMock: ReturnType<typeof vi.fn>;
  started: Promise<AbortSignal>;
} {
  let announce!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    announce = resolve;
  });
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error('expected a bounded request signal');
    announce(signal);
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(
        signal.reason ?? new DOMException('Aborted', 'AbortError'),
      );
      if (signal.aborted) rejectAbort();
      else signal.addEventListener('abort', rejectAbort, { once: true });
    });
  });
  return { fetchMock, started };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SolidgateClient request deadline', () => {
  it('aborts a provider call at the shared default deadline', async () => {
    vi.useFakeTimers();
    const { fetchMock, started } = abortablePendingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const request = new SolidgateClient(KEYS).status({ order_id: 'order-1' });
    const rejection = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
    const signal = await started;

    await vi.advanceTimersByTimeAsync(SOLIDGATE_REQUEST_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await rejection;
  });

  it('relays an earlier caller abort through status()', async () => {
    const { fetchMock, started } = abortablePendingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const caller = new AbortController();

    const request = new SolidgateClient(KEYS).status(
      { order_id: 'order-2' },
      caller.signal,
    );
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const bounded = await started;
    caller.abort(new DOMException('Caller stopped waiting', 'AbortError'));

    expect(bounded.aborted).toBe(true);
    await rejection;
  });
});
