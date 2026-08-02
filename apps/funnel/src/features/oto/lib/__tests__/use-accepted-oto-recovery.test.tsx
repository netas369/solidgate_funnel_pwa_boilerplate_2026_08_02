import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptedOtoRecoveryKey,
  clearAcceptedOtoRecoveryMemoryForTests,
  dismissDeclinedAcceptedOtoOrders,
  forgetAcceptedOtoRecoveryOrder,
  readAcceptedOtoRecoveryOrders,
  readDeclinedAcceptedOtoOrders,
  rememberAcceptedOtoRecoveryOrder,
} from '../accepted-oto-recovery';

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('../charge-oto', () => ({
  resumeSolidgateOto: mocks.resume,
}));

const { useAcceptedOtoRecovery } = await import('../use-accepted-oto-recovery');

const SESSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PROCESSING_ORDER = `${SESSION_ID}:oto3_bundle_all:1`;

describe('accepted OTO background recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
    vi.clearAllMocks();
    window.localStorage.clear();
    clearAcceptedOtoRecoveryMemoryForTests();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'https://funnel.example.com/lt/oto/4',
        assign: mocks.assign,
      },
    });
  });

  it('redirects a processing order to its later 3DS challenge from the next OTO', async () => {
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: PROCESSING_ORDER,
      productSlug: 'oto3_bundle_all',
    })).toBe(true);
    mocks.resume
      .mockResolvedValueOnce({
        ok: false,
        pending: true,
        accepted: true,
        orderId: PROCESSING_ORDER,
        providerStatus: 'processing',
      })
      .mockResolvedValueOnce({
        ok: false,
        redirecting: true,
        verifyUrl: 'https://acs.example/verify/oto3-order',
        orderId: PROCESSING_ORDER,
      });

    renderHook(() => useAcceptedOtoRecovery(SESSION_ID));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.resume).toHaveBeenLastCalledWith(expect.objectContaining({
      slug: 'oto3_bundle_all',
      sessionId: SESSION_ID,
      orderId: PROCESSING_ORDER,
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.resume).toHaveBeenCalledTimes(2);
    expect(mocks.assign).toHaveBeenCalledWith('https://acs.example/verify/oto3-order');
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toHaveLength(1);
  });

  it('records a durable declined notice instead of silently dropping a declined accepted order', async () => {
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: PROCESSING_ORDER,
      productSlug: 'oto3_bundle_all',
    })).toBe(true);
    mocks.resume.mockResolvedValueOnce({
      ok: false,
      error: 'Payment failed',
      code: 'payment_failed',
      orderId: PROCESSING_ORDER,
    });

    renderHook(() => useAcceptedOtoRecovery(SESSION_ID));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The dead order leaves the recovery queue, but the buyer-visible notice
    // survives navigation until dismissed — the silent-skip UX hole.
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([]);
    expect(readDeclinedAcceptedOtoOrders(SESSION_ID)).toMatchObject([
      { orderId: PROCESSING_ORDER, productSlug: 'oto3_bundle_all' },
    ]);

    dismissDeclinedAcceptedOtoOrders(SESSION_ID);
    expect(readDeclinedAcceptedOtoOrders(SESSION_ID)).toEqual([]);
  });

  it('does not record a "card was not charged" notice for a captured-then-reversed order', async () => {
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: PROCESSING_ORDER,
      productSlug: 'oto3_bundle_all',
    })).toBe(true);
    // grant_revoked = the charge captured and was later refunded/disputed; the
    // decline banner's no-charge claim would be false for this buyer.
    mocks.resume.mockResolvedValueOnce({
      ok: false,
      error: 'Purchase is no longer grantable',
      code: 'grant_revoked',
      orderId: PROCESSING_ORDER,
    });

    renderHook(() => useAcceptedOtoRecovery(SESSION_ID));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([]);
    expect(readDeclinedAcceptedOtoOrders(SESSION_ID)).toEqual([]);
  });

  it('rejects tampered cross-session and non-canonical order bindings', () => {
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: `${SESSION_ID}:oto3_bundle_all:not-an-attempt`,
      productSlug: 'oto3_bundle_all',
    })).toBe(false);
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:oto3_bundle_all:1',
      productSlug: 'oto3_bundle_all',
    })).toBe(false);
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([]);
  });

  it('keeps a newly accepted order when readable localStorage is stale and writes fail', () => {
    const staleOrder = `${SESSION_ID}:oto1_lifetime:1`;
    const newOrder = `${SESSION_ID}:oto2_addon_weekly:1`;
    window.localStorage.setItem(acceptedOtoRecoveryKey(SESSION_ID), JSON.stringify([{
      sessionId: SESSION_ID,
      orderId: staleOrder,
      productSlug: 'oto1_lifetime',
      createdAt: Date.now() - 1_000,
    }]));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'QuotaExceededError');
    });

    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: newOrder,
      productSlug: 'oto2_addon_weekly',
    })).toBe(true);

    expect(readAcceptedOtoRecoveryOrders(SESSION_ID).map(({ orderId }) => orderId)).toEqual([
      staleOrder,
      newOrder,
    ]);
  });

  it('does not resurrect a forgotten order when removing stale localStorage fails', () => {
    expect(rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: PROCESSING_ORDER,
      productSlug: 'oto3_bundle_all',
    })).toBe(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('storage denied', 'SecurityError');
    });

    expect(forgetAcceptedOtoRecoveryOrder(SESSION_ID, PROCESSING_ORDER)).toBe(true);
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID)).toEqual([]);
  });

  it('settles queued orders oldest-first without navigating back to their OTO', async () => {
    const firstOrder = `${SESSION_ID}:oto3_bundle_all:1`;
    const secondOrder = `${SESSION_ID}:oto4_pdf:1`;
    rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: firstOrder,
      productSlug: 'oto3_bundle_all',
    });
    vi.setSystemTime(new Date('2026-07-21T12:00:01.000Z'));
    rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: secondOrder,
      productSlug: 'oto4_pdf',
    });
    mocks.resume
      .mockResolvedValueOnce({ ok: true, orderId: firstOrder })
      .mockResolvedValueOnce({
        ok: false,
        redirecting: true,
        verifyUrl: 'https://acs.example/verify/oto4-order',
        orderId: secondOrder,
      });

    renderHook(() => useAcceptedOtoRecovery(SESSION_ID));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(mocks.resume.mock.calls.map(([params]) => params.orderId)).toEqual([
      firstOrder,
      secondOrder,
    ]);
    expect(mocks.assign).toHaveBeenCalledWith('https://acs.example/verify/oto4-order');
    expect(readAcceptedOtoRecoveryOrders(SESSION_ID).map(({ orderId }) => orderId)).toEqual([
      secondOrder,
    ]);
  });

  it('does not let an older processing order hide a later 3DS challenge', async () => {
    const olderOrder = `${SESSION_ID}:oto1_lifetime:1`;
    const laterOrder = `${SESSION_ID}:oto2_addon_weekly:1`;
    rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: olderOrder,
      productSlug: 'oto1_lifetime',
    });
    vi.setSystemTime(new Date('2026-07-21T12:00:01.000Z'));
    rememberAcceptedOtoRecoveryOrder({
      sessionId: SESSION_ID,
      orderId: laterOrder,
      productSlug: 'oto2_addon_weekly',
    });
    mocks.resume
      .mockResolvedValueOnce({
        ok: false,
        pending: true,
        accepted: true,
        orderId: olderOrder,
        providerStatus: 'processing',
      })
      .mockResolvedValueOnce({
        ok: false,
        redirecting: true,
        verifyUrl: 'https://acs.example/verify/oto2-order',
        orderId: laterOrder,
      });

    renderHook(() => useAcceptedOtoRecovery(SESSION_ID));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.resume.mock.calls.map(([params]) => params.orderId)).toEqual([
      olderOrder,
      laterOrder,
    ]);
    expect(mocks.assign).toHaveBeenCalledWith('https://acs.example/verify/oto2-order');
  });
});
