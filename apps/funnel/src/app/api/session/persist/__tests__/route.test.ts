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

describe('POST /api/session/persist', () => {
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
    // Default: treat as existing row (UPDATE path)
    mockMaybeSingle.mockResolvedValue({ data: { id: SID, locale: 'en' } });
    mockInsertResult.mockResolvedValue({ error: null });
    mockUpdateResult.mockResolvedValue({ error: null });
  });

  it('returns 400 for missing sessionId', async () => {
    const response = await postRoute({});

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing sessionId' });
  });

  it('updates session on existing row with currentStepId/answers', async () => {
    const response = await postRoute({
      sessionId: SID,
      currentStepId: 'q2',
      answers: { q1: 'a' },
    });

    expect(response.status).toBe(200);
    // Route returns { ok: true, hydrated } — hydrated is false for a plain
    // quiz-flow update (no special-offer source, no email).
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        current_step_id: 'q2',
        quiz_answers: { q1: 'a' },
      }),
    );
  });

  it('returns 500 on database error (update branch)', async () => {
    mockUpdateResult.mockResolvedValue({ error: { message: 'db fail' } });

    const response = await postRoute({
      sessionId: SID,
      currentStepId: 'q1',
      answers: {},
    });

    expect(response.status).toBe(500);
  });

  it('updates email field when provided', async () => {
    const response = await postRoute({
      sessionId: SID,
      email: 'test@example.com',
    });

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'test@example.com',
      }),
    );
  });

  it('updates resultSegment field when provided', async () => {
    const response = await postRoute({
      sessionId: SID,
      resultSegment: 'weight_loss',
    });

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        result_segment: 'weight_loss',
      }),
    );
  });

  it('returns 400 for invalid locale string', async () => {
    const response = await postRoute({ sessionId: SID, locale: 'xx' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid locale' });
  });

  it('returns 400 for locale with wrong type', async () => {
    const response = await postRoute({ sessionId: SID, locale: 123 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid locale' });
  });

  it('returns 400 when new session has no locale', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null });

    const response = await postRoute({ sessionId: SID, currentStepId: 'step-1' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Missing locale for new session',
    });
  });

  it('persists locale on first write (INSERT branch)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null });

    const response = await postRoute({ sessionId: SID, locale: 'cs' });

    expect(response.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: SID, locale: 'cs' }),
    );
  });

  it('(v46) writes locale on UPDATE branch when provided for existing session', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: SID, locale: 'en' } });

    const response = await postRoute({ sessionId: SID, locale: 'cs' });

    expect(response.status).toBe(200);
    const updateArg = mockUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toBeDefined();
    expect(updateArg).toHaveProperty('locale', 'cs');
  });

  it('(v46) does NOT set locale key on UPDATE when not provided', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: SID, locale: 'en' } });

    const response = await postRoute({ sessionId: SID, currentStepId: 'q3' });

    expect(response.status).toBe(200);
    const updateArg = mockUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg).toBeDefined();
    expect(updateArg).not.toHaveProperty('locale');
  });

  it('allows UPDATE without locale when row exists', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: SID } });

    const response = await postRoute({ sessionId: SID, currentStepId: 'step-5' });

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it.each(['en', 'lt', 'lv', 'el', 'hr', 'cs', 'zh-TW', 'ru'])(
    'accepts routing locale %s on INSERT',
    async (loc) => {
      mockMaybeSingle.mockResolvedValue({ data: null });

      const response = await postRoute({ sessionId: SID, locale: loc });

      expect(response.status).toBe(200);
    },
  );
});
