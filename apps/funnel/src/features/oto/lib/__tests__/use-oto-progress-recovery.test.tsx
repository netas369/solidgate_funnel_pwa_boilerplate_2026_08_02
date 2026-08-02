import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistOtoProgressBestEffort } from '../advance-oto';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

const { useOtoProgressRecovery } = await import('../use-oto-progress-recovery');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function Harness() {
  useOtoProgressRecovery(SESSION_ID, true);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/lt/oto/3');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('late OTO progress recovery', () => {
  it('follows a canonical checkpoint that completed before the next page mounted', async () => {
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        lastOtoStep: '6',
        resumeTo: '/oto/6',
      }), { status: 200 })) as unknown as typeof fetch,
    });

    render(<Harness />);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lt/oto/6'));
  });

  it('reacts to a late same-tab response but never navigates backward', async () => {
    render(<Harness />);
    expect(mocks.replace).not.toHaveBeenCalled();

    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 3,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        lastOtoStep: '7',
        resumeTo: '/oto/7',
      }), { status: 200 })) as unknown as typeof fetch,
    });
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lt/oto/7'));

    window.history.replaceState({}, '', '/lt/oto/7');
    mocks.replace.mockClear();
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        lastOtoStep: '4',
        resumeTo: '/oto/4',
      }), { status: 200 })) as unknown as typeof fetch,
    });

    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('never replaces an ACS return while its exact confirmation marker remains', async () => {
    await persistOtoProgressBestEffort({
      sessionId: SESSION_ID,
      currentStep: 2,
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        lastOtoStep: '7',
        resumeTo: '/oto/7',
      }), { status: 200 })) as unknown as typeof fetch,
    });
    window.history.replaceState(
      {},
      '',
      `/lt/oto/3?sg_confirm=${SESSION_ID}:oto3_bundle_all:1`,
    );

    render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.replace).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent('solidgate:oto-canonical-progress', {
      detail: { sessionId: SESSION_ID },
    }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: `solidgate-oto-canonical:${SESSION_ID}`,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
