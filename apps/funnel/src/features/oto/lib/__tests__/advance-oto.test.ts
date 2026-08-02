import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceOtoBeforeNavigation,
  flushPendingOtoProgressBestEffort,
  persistOtoProgressBestEffort,
  readCanonicalOtoProgress,
  resolveCanonicalOtoRecoveryTarget,
  resolveOtoNavigationTarget,
} from '../advance-oto';

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('durable OTO skip navigation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('starts the canonical progress request before navigating', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })) as unknown as typeof fetch;
    const navigate = vi.fn();

    const advancing = advanceOtoBeforeNavigation({
      sessionId: SESSION_ID,
      currentStep: 5,
      waitMs: 1_000,
      fetchImpl,
      navigate,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/solidgate/advance-oto', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, currentStep: 5 }),
    });
    expect(navigate).not.toHaveBeenCalled();

    resolveRequest(new Response('{}', { status: 200 }));
    await advancing;

    expect(navigate).toHaveBeenCalledWith('/oto/6');
  });

  it('navigates after the bounded wait while the keepalive request remains in flight', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const navigate = vi.fn();

    const advancing = advanceOtoBeforeNavigation({
      sessionId: SESSION_ID,
      currentStep: 2,
      waitMs: 250,
      fetchImpl,
      navigate,
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(navigate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await advancing;

    expect(navigate).toHaveBeenCalledWith('/oto/3');
  });

  it('retains a canonical response that arrives after the navigation budget', async () => {
    vi.useFakeTimers();
    let resolveRequest!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    })) as unknown as typeof fetch;
    const navigate = vi.fn();

    const advancing = advanceOtoBeforeNavigation({
      sessionId: SESSION_ID,
      currentStep: 2,
      waitMs: 250,
      fetchImpl,
      navigate,
    });
    await vi.advanceTimersByTimeAsync(250);
    await advancing;
    expect(navigate).toHaveBeenCalledWith('/oto/3');

    resolveRequest(new Response(JSON.stringify({
      lastOtoStep: '6',
      resumeTo: '/oto/6',
    }), { status: 200 }));
    await vi.waitFor(() => {
      expect(readCanonicalOtoProgress(SESSION_ID)).toMatchObject({
        lastOtoStep: '6',
        resumeTo: '/oto/6',
      });
    });
    expect(resolveCanonicalOtoRecoveryTarget(
      readCanonicalOtoProgress(SESSION_ID),
      '/lt/oto/3',
    )).toBe('/lt/oto/6');
  });

  it('treats persistence failure as best-effort and still navigates once', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const navigate = vi.fn();

    await advanceOtoBeforeNavigation({
      sessionId: SESSION_ID,
      currentStep: 7,
      fetchImpl,
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith('/oto/8');
  });

  it('replays a failed earlier skip before advancing the next page', async () => {
    const firstFetch = vi.fn().mockRejectedValue(new Error('temporary outage')) as unknown as typeof fetch;
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 1,
      fetchImpl: firstFetch,
    });

    const recoveredFetch = vi.fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: recoveredFetch as unknown as typeof fetch,
    });

    expect(recoveredFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(recoveredFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      sessionId: SESSION_ID,
      currentStep: 1,
    });
    expect(JSON.parse(String(recoveredFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      sessionId: SESSION_ID,
      currentStep: 2,
    });
  });

  it('repairs only a server-proven one-step hole after storage loss', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ lastOtoStep: '1' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).currentStep).toBe(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).currentStep).toBe(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).currentStep).toBe(2);
  });

  it('flushes an OTO7 failure when the next OTO (including OTO8) mounts', async () => {
    const failedFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 7,
      fetchImpl: failedFetch as unknown as typeof fetch,
    })).resolves.toBe(false);

    const recoveredFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lastOtoStep: '8',
      resumeTo: '/oto/8',
    }), { status: 200 }));
    await expect(flushPendingOtoProgressBestEffort({
      sessionId: SESSION_ID,
      fetchImpl: recoveredFetch as unknown as typeof fetch,
    })).resolves.toBe(true);

    expect(recoveredFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(recoveredFetch.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: SESSION_ID,
      currentStep: 7,
    });
  });

  it('merges the memory fallback when reads work but localStorage writes fail', async () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    const failedFetch = vi.fn().mockRejectedValue(new Error('offline'));
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 1,
      fetchImpl: failedFetch as unknown as typeof fetch,
    });
    storageWrite.mockRestore();

    const recoveredFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: recoveredFetch as unknown as typeof fetch,
    });

    expect(recoveredFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(recoveredFetch.mock.calls[0]?.[1]?.body)).currentStep).toBe(1);
    expect(JSON.parse(String(recoveredFetch.mock.calls[1]?.[1]?.body)).currentStep).toBe(2);
  });

  it('uses a later canonical checkpoint returned to a stale tab', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lastOtoStep: '6',
      resumeTo: '/oto/6',
    }), { status: 200 }));
    const navigate = vi.fn();

    await advanceOtoBeforeNavigation({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith('/oto/6');
  });

  it('never regresses the retained checkpoint or derives a recovery step from a stale page', async () => {
    const later = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lastOtoStep: '7',
      resumeTo: '/oto/7',
    }), { status: 200 }));
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: later as unknown as typeof fetch,
    });

    const older = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      lastOtoStep: '4',
      resumeTo: '/oto/4',
    }), { status: 200 }));
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 3,
      fetchImpl: older as unknown as typeof fetch,
    });

    expect(readCanonicalOtoProgress(SESSION_ID)).toMatchObject({ lastOtoStep: '7' });
    expect(resolveCanonicalOtoRecoveryTarget({}, '/oto/3')).toBeNull();
    expect(resolveCanonicalOtoRecoveryTarget({ lastOtoStep: '2' }, '/oto/3')).toBeNull();
  });

  it('rejects off-site, malformed, mismatched, and backward resume routes', () => {
    expect(resolveOtoNavigationTarget({ resumeTo: 'https://evil.example/oto/8' }, 3))
      .toBe('/oto/4');
    expect(resolveOtoNavigationTarget({ resumeTo: '/oto/8?next=evil' }, 3))
      .toBe('/oto/4');
    expect(resolveOtoNavigationTarget({ lastOtoStep: '6', resumeTo: '/oto/2' }, 3))
      .toBe('/oto/6');
    expect(resolveOtoNavigationTarget({ lastOtoStep: '2', resumeTo: '/oto/2' }, 3))
      .toBe('/oto/4');
  });

  it('does not call the API without a session', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(persistOtoProgressBestEffort({
      sessionId: null,
      currentStep: 1,
      fetchImpl,
    })).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
