import { StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OtoChargeOutcome } from '../charge-oto';

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
}));

vi.mock('../charge-oto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../charge-oto')>()),
  resumeSolidgateOto: mocks.resume,
}));

const {
  OTO_RESUME_MAX_AUTO_RETRIES,
  OTO_RESUME_RETRY_MS,
  useSolidgateOtoResume,
} = await import('../use-solidgate-oto-resume');

const ORDER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6:oto5_pdf:1';
const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(
    { __NA: true, tree: ['oto', '5'] },
    '',
    `/oto/5?campaign=return&sg_confirm=${encodeURIComponent(ORDER_ID)}`,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSolidgateOtoResume lifecycle', () => {
  it('does not abort or duplicate confirmation when page callbacks change on rerender', async () => {
    let resolveResume!: (outcome: OtoChargeOutcome) => void;
    mocks.resume.mockReturnValue(new Promise<OtoChargeOutcome>((resolve) => {
      resolveResume = resolve;
    }));
    const accepted = vi.fn();

    function Harness({ version }: { version: number }) {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: () => undefined,
        onAccepted: (outcome) => accepted(version, outcome.orderId),
        onPending: () => undefined,
        onError: () => undefined,
      });
      return null;
    }

    const view = render(<Harness version={1} />);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    const firstSignal = mocks.resume.mock.calls[0]?.[0].signal as AbortSignal;

    view.rerender(<Harness version={2} />);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(firstSignal.aborted).toBe(false);

    resolveResume({
      ok: false,
      pending: true,
      accepted: true,
      orderId: ORDER_ID,
      nextOto: '/oto/6',
    });
    await waitFor(() => expect(accepted).toHaveBeenCalledWith(2, ORDER_ID));
  });

  it('retains the consumed order identity across strict-mode cleanup and replacement', async () => {
    mocks.resume.mockReturnValue(new Promise<OtoChargeOutcome>(() => {}));

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: () => undefined,
      });
      return null;
    }

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(2));
    expect(mocks.resume.mock.calls.map(([call]) => call.orderId)).toEqual([ORDER_ID, ORDER_ID]);
    expect((mocks.resume.mock.calls[0]?.[0].signal as AbortSignal).aborted).toBe(true);
    expect((mocks.resume.mock.calls[1]?.[0].signal as AbortSignal).aborted).toBe(false);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(ORDER_ID);
  });

  it('never copies an aborted confirmation marker onto the next route and Back retains it', async () => {
    mocks.resume.mockImplementation(({ signal }: { signal: AbortSignal }) => (
      new Promise<OtoChargeOutcome>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })
    ));
    const pending = vi.fn();
    const errored = vi.fn();

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: () => undefined,
        onPending: pending,
        onError: errored,
      });
      return null;
    }

    const view = render(<Harness />);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    window.history.pushState({ __NA: true, tree: ['oto', '6'] }, '', '/oto/6');
    view.unmount();

    expect(new URL(window.location.href).searchParams.has('sg_confirm')).toBe(false);
    expect(pending).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();

    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe('/oto/5'));
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(ORDER_ID);
  });

  it('suppresses a late accepted callback after pathname navigation', async () => {
    let resolveResume!: (outcome: OtoChargeOutcome) => void;
    mocks.resume.mockReturnValue(new Promise<OtoChargeOutcome>((resolve) => {
      resolveResume = resolve;
    }));
    const accepted = vi.fn();
    const succeeded = vi.fn();

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: succeeded,
        onAccepted: accepted,
      });
      return null;
    }

    render(<Harness />);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
    window.history.pushState({}, '', '/oto/6');
    resolveResume({
      ok: false,
      pending: true,
      accepted: true,
      orderId: ORDER_ID,
      productSlug: 'oto5_pdf',
      nextOto: '/oto/6',
    });
    await Promise.resolve();

    expect(accepted).not.toHaveBeenCalled();
    expect(succeeded).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.has('sg_confirm')).toBe(false);
  });

  it('rejects a wrong-page provider outcome before purchase analytics or navigation', async () => {
    mocks.resume.mockResolvedValue({
      ok: true,
      orderId: ORDER_ID,
      productSlug: 'oto4_pdf',
    } satisfies OtoChargeOutcome);
    const succeeded = vi.fn();
    const accepted = vi.fn();
    const errored = vi.fn();

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: succeeded,
        onAccepted: accepted,
        onError: errored,
      });
      return null;
    }

    render(<Harness />);
    await waitFor(() => expect(errored).toHaveBeenCalledWith('binding_mismatch'));
    expect(succeeded).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.has('sg_confirm')).toBe(false);
  });

  it('retries the exact same pending order at low cadence until it is accepted', async () => {
    vi.useFakeTimers();
    mocks.resume
      .mockResolvedValueOnce({
        ok: false,
        pending: true,
        orderId: ORDER_ID,
        productSlug: 'oto5_pdf',
      } satisfies OtoChargeOutcome)
      .mockResolvedValueOnce({
        ok: false,
        pending: true,
        accepted: true,
        orderId: ORDER_ID,
        productSlug: 'oto5_pdf',
        lastOtoStep: '6',
        resumeTo: '/oto/6',
      } satisfies OtoChargeOutcome);
    const pending = vi.fn();
    const accepted = vi.fn();

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: () => undefined,
        onAccepted: accepted,
        onPending: pending,
      });
      return null;
    }

    render(<Harness />);
    await act(async () => undefined);
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(ORDER_ID);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OTO_RESUME_RETRY_MS - 1);
    });
    expect(mocks.resume).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.resume.mock.calls.map(([call]) => call.orderId)).toEqual([ORDER_ID, ORDER_ID]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.has('sg_confirm')).toBe(false);
  });

  it('stops automatic pending reconciliation at the shared order retry cap', async () => {
    vi.useFakeTimers();
    mocks.resume.mockResolvedValue({
      ok: false,
      pending: true,
      orderId: ORDER_ID,
      productSlug: 'oto5_pdf',
    } satisfies OtoChargeOutcome);

    function Harness() {
      useSolidgateOtoResume({
        slug: 'oto5_pdf',
        sessionId: SESSION_ID,
        onSuccess: () => undefined,
      });
      return null;
    }

    render(<Harness />);
    await act(async () => undefined);
    for (let attempt = 0; attempt < OTO_RESUME_MAX_AUTO_RETRIES + 2; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OTO_RESUME_RETRY_MS);
      });
    }

    expect(mocks.resume).toHaveBeenCalledTimes(1 + OTO_RESUME_MAX_AUTO_RETRIES);
    expect(mocks.resume.mock.calls.every(([call]) => call.orderId === ORDER_ID)).toBe(true);
    expect(new URL(window.location.href).searchParams.get('sg_confirm')).toBe(ORDER_ID);
  });
});
