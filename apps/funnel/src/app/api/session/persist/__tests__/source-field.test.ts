// Phase 1038 SO-08 + SO-09  -  Wave 0 RED.
//
// Locks TWO downstream contracts on /api/session/persist:
//   SO-08: The handler accepts `source` in the body. `'special-offer'` and
//          `'quiz'` are the two allowed values this phase ships (D-11);
//          unknown strings must return HTTP 400.
//   SO-09: `addContactToEmailList` from @/lib/activecampaign/client MUST NOT
//          be called when source==='special-offer' (D-10, Pitfall 4). It
//          MUST still be called for source==='quiz' (regression protection
//          for Phase 1037's AC wiring) and when source is omitted (backward
//          compat  -  default behavior does not change).
//
// RED pre-implementation reasons:
//   - The route does not yet read body.source → update.source is never set →
//     assertion on update payload will fail for special-offer / quiz cases.
//   - The AC-skip guard doesn't exist → assertion on vi.fn().mock.calls
//     length 0 for special-offer case will fail (handler fires AC today).
//   - The invalid-source 400 doesn't exist → the handler returns 200 for
//     unknown sources today.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInsertResult = vi.fn();
const mockUpdateResult = vi.fn();
const mockInsert = vi.fn<
  (values: Record<string, unknown>) => ReturnType<typeof mockInsertResult>
>(() => mockInsertResult());
const mockUpdateEq = vi.fn(() => mockUpdateResult());
const mockUpdate = vi.fn<
  (values: Record<string, unknown>) => { eq: typeof mockUpdateEq }
>(() => ({ eq: mockUpdateEq }));
const mockMaybeSingle = vi.fn();
const mockSelectEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = vi.fn(() => ({ eq: mockSelectEq }));

vi.mock('next/headers', () => ({}));

vi.mock('@repo/shared/supabase/admin', () => ({
  getSupabaseAdminClient: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
    })),
  })),
}));

// AC client mock  -  this is the observable surface for SO-09.
const mockAddContactToEmailList = vi.fn();
vi.mock('@/lib/activecampaign/client', () => ({
  addContactToEmailList: mockAddContactToEmailList,
}));

async function postRoute(body: unknown) {
  const { POST } = await import('../route');
  return POST(
    new Request('http://localhost/api/session/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const SID = '11111111-2222-3333-4444-555555555555';

describe('Phase 1038 SO-08 + SO-09  -  /api/session/persist source field', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInsert.mockClear();
    mockUpdate.mockClear();
    mockUpdateEq.mockClear();
    mockSelect.mockClear();
    mockSelectEq.mockClear();
    mockInsertResult.mockReset();
    mockUpdateResult.mockReset();
    mockMaybeSingle.mockReset();
    mockAddContactToEmailList.mockReset();
    // Default: existing session row  -  exercises the UPDATE branch.
    mockMaybeSingle.mockResolvedValue({ data: { id: SID, locale: 'en' } });
    mockInsertResult.mockResolvedValue({ error: null });
    mockUpdateResult.mockResolvedValue({ error: null });
    mockAddContactToEmailList.mockResolvedValue(undefined);
  });

  it('accepts source: special-offer in body and writes it to the sessions row', async () => {
    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
      source: 'special-offer',
    });

    expect(res.status).toBe(200);
    const updateArg = mockUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toBeDefined();
    expect(updateArg).toHaveProperty('source', 'special-offer');
  });

  it('rejects unknown source values with HTTP 400', async () => {
    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
      source: 'unknown-value',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/[Ii]nvalid source/);
  });

  it('does NOT call addContactToEmailList when source === special-offer', async () => {
    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
      source: 'special-offer',
    });

    expect(res.status).toBe(200);
    // Flush pending microtasks so the handler's fire-and-forget
    // `void addContactToEmailList(...)` has a chance to enqueue if the guard
    // failed to skip it. Microtask resolution via immediately-resolved
    // Promise  -  no polling / no setTimeout.
    await Promise.resolve();
    expect(mockAddContactToEmailList).not.toHaveBeenCalled();
  });

  it('still calls addContactToEmailList when source === quiz (regression for existing flow)', async () => {
    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
      source: 'quiz',
    });

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(mockAddContactToEmailList).toHaveBeenCalledTimes(1);
    expect(mockAddContactToEmailList).toHaveBeenCalledWith('test@example.com', 'en');
  });

  it('still calls addContactToEmailList when source is undefined (backward-compat)', async () => {
    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
    });

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(mockAddContactToEmailList).toHaveBeenCalledTimes(1);
  });

  it('also accepts source: special-offer on INSERT branch (new session row)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null });

    const res = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
      locale: 'en',
      source: 'special-offer',
    });

    expect(res.status).toBe(200);
    const insertArg = mockInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg).toBeDefined();
    expect(insertArg).toHaveProperty('source', 'special-offer');
  });
});
