import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { persistSessionSnapshot, captureLeadRecord } from '../use-quiz-persistence';

describe('persistSessionSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('calls fetch /api/session/persist with correct shape', () => {
    persistSessionSnapshot('session-123', 'step-2', { q1: 'a' });

    // Phase 1038 D-11: source: 'quiz' now included in all quiz-flow persist
    // bodies so sessions.source is populated end-to-end from the funnel.
    expect(mockFetch).toHaveBeenCalledWith('/api/session/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-123', currentStepId: 'step-2', answers: { q1: 'a' }, source: 'quiz' }),
    });
  });

  it('returns void (fire-and-forget)', () => {
    const result = persistSessionSnapshot('session-123', 'step-1', {});
    expect(result).toBeUndefined();
  });

  it('logs error on failure but does not throw', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('Network error'));

    persistSessionSnapshot('session-123', 'step-1', {});

    // Wait for the .catch() to resolve
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[persistence]'),
        expect.any(Error)
      );
    });

    consoleSpy.mockRestore();
  });
});

describe('captureLeadRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('calls fetch /api/session/persist with email and correct shape', async () => {
    await captureLeadRecord('session-456', 'test@example.com', { q1: 'b' });

    // Phase 1038 D-11: source: 'quiz' distinguishes quiz-flow email capture from
    // the special-offer email gate (Plan 07, source: 'special-offer'). Required
    // for the AC guard in /api/session/persist to correctly fire AC here.
    expect(mockFetch).toHaveBeenCalledWith('/api/session/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-456', email: 'test@example.com', answers: { q1: 'b' }, source: 'quiz' }),
    });
  });

  it('returns { success: true } on success', async () => {
    const result = await captureLeadRecord('session-456', 'test@example.com', {});
    expect(result).toEqual({ success: true });
  });

  it('returns { success: false } on non-ok response and logs to console', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unique violation' }), { status: 500 })
    );

    const result = await captureLeadRecord('session-456', 'test@example.com', {});

    expect(result).toEqual({ success: false });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[lead-capture]'),
      expect.any(String)
    );

    consoleSpy.mockRestore();
  });

  it('returns { success: false } on fetch error and logs to console', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await captureLeadRecord('session-456', 'test@example.com', {});

    expect(result).toEqual({ success: false });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[lead-capture]'),
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
