import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Admin client mock ────────────────────────────────────────────────────────
const mockInsert = vi.fn();
const mockGte = vi.fn();
const mockOrder = vi.fn(() => ({ then: undefined })); // placeholder, overridden below
const mockEqSuccess = vi.fn();
const mockEqEmail = vi.fn();
const mockSelect = vi.fn();

// Build a chainable mock: select → eq(email) → eq(success) → gte → order → resolves
function buildChain(result: unknown) {
  const orderFn = vi.fn().mockResolvedValue(result);
  const gteFn = vi.fn(() => ({ order: orderFn }));
  const eqSuccessFn = vi.fn(() => ({ gte: gteFn }));
  const eqEmailFn = vi.fn(() => ({ eq: eqSuccessFn }));
  const selectFn = vi.fn(() => ({ eq: eqEmailFn }));
  const insertFn = vi.fn().mockResolvedValue({ error: null });
  return { selectFn, eqEmailFn, eqSuccessFn, gteFn, orderFn, insertFn };
}

vi.mock('../supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(),
}));

import { getSupabaseAdminClient } from '../supabase/admin';
import { checkOtpRateLimit, recordOtpAttempt } from '../auth/otp-rate-limit';

const mockAdmin = getSupabaseAdminClient as ReturnType<typeof vi.fn>;

describe('checkOtpRateLimit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns allowed:true when there are no recent failures', async () => {
    const { selectFn, eqEmailFn, eqSuccessFn, gteFn, orderFn, insertFn } = buildChain({
      data: [],
      error: null,
    });
    mockAdmin.mockReturnValue({
      from: vi.fn(() => ({ select: selectFn, insert: insertFn })),
    });
    // Wire chain
    selectFn.mockReturnValue({ eq: eqEmailFn });
    eqEmailFn.mockReturnValue({ eq: eqSuccessFn });
    eqSuccessFn.mockReturnValue({ gte: gteFn });
    gteFn.mockReturnValue({ order: orderFn });
    orderFn.mockResolvedValue({ data: [], error: null });

    const result = await checkOtpRateLimit('test@example.com');
    expect(result).toEqual({ allowed: true });
  });

  it('returns soft_lock after 5 failures within 15 minutes', async () => {
    const now = new Date();
    // 5 failures all within the last 5 minutes
    const recentFailures = Array.from({ length: 5 }, (_, i) => ({
      attempted_at: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(),
    }));

    const { selectFn, eqEmailFn, eqSuccessFn, gteFn, orderFn, insertFn } = buildChain({
      data: recentFailures,
      error: null,
    });
    mockAdmin.mockReturnValue({
      from: vi.fn(() => ({ select: selectFn, insert: insertFn })),
    });
    selectFn.mockReturnValue({ eq: eqEmailFn });
    eqEmailFn.mockReturnValue({ eq: eqSuccessFn });
    eqSuccessFn.mockReturnValue({ gte: gteFn });
    gteFn.mockReturnValue({ order: orderFn });
    orderFn.mockResolvedValue({ data: recentFailures, error: null });

    const result = await checkOtpRateLimit('test@example.com');
    expect(result).toEqual({ allowed: false, reason: 'soft_lock', retryAfterMinutes: 15 });
  });

  it('returns hard_lock after 10 failures within 1 hour', async () => {
    const now = new Date();
    // 10 failures spread across the last 45 minutes (all within hard window, some outside soft window)
    const recentFailures = Array.from({ length: 10 }, (_, i) => ({
      attempted_at: new Date(now.getTime() - (i + 1) * 4.5 * 60 * 1000).toISOString(),
    }));

    const { selectFn, eqEmailFn, eqSuccessFn, gteFn, orderFn, insertFn } = buildChain({
      data: recentFailures,
      error: null,
    });
    mockAdmin.mockReturnValue({
      from: vi.fn(() => ({ select: selectFn, insert: insertFn })),
    });
    selectFn.mockReturnValue({ eq: eqEmailFn });
    eqEmailFn.mockReturnValue({ eq: eqSuccessFn });
    eqSuccessFn.mockReturnValue({ gte: gteFn });
    gteFn.mockReturnValue({ order: orderFn });
    orderFn.mockResolvedValue({ data: recentFailures, error: null });

    const result = await checkOtpRateLimit('test@example.com');
    expect(result).toEqual({ allowed: false, reason: 'hard_lock', retryAfterMinutes: 60 });
  });

  it('returns allowed:true on DB error (fail-open)', async () => {
    const { selectFn, eqEmailFn, eqSuccessFn, gteFn, orderFn, insertFn } = buildChain(null);
    mockAdmin.mockReturnValue({
      from: vi.fn(() => ({ select: selectFn, insert: insertFn })),
    });
    selectFn.mockReturnValue({ eq: eqEmailFn });
    eqEmailFn.mockReturnValue({ eq: eqSuccessFn });
    eqSuccessFn.mockReturnValue({ gte: gteFn });
    gteFn.mockReturnValue({ order: orderFn });
    orderFn.mockResolvedValue({ data: null, error: { message: 'connection refused' } });

    const result = await checkOtpRateLimit('test@example.com');
    expect(result).toEqual({ allowed: true });
  });
});

describe('recordOtpAttempt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a row with the correct shape', async () => {
    const insertFn = vi.fn().mockResolvedValue({ error: null });
    mockAdmin.mockReturnValue({
      from: vi.fn(() => ({ insert: insertFn })),
    });

    await recordOtpAttempt('user@example.com', false, '1.2.3.4');

    expect(insertFn).toHaveBeenCalledWith({
      email: 'user@example.com',
      success: false,
      ip_address: '1.2.3.4',
    });
  });
});
