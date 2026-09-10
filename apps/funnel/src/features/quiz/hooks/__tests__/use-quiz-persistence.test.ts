import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuizStore } from '@/stores/quiz-store';

const { mockCaptureAttributionParams } = vi.hoisted(() => ({
  mockCaptureAttributionParams: vi.fn(),
}));

vi.mock('@/features/analytics/lib/attribution', () => ({
  captureAttributionParams: mockCaptureAttributionParams,
}));

import {
  captureLeadRecord,
  completeQuizSession,
  createQuizSession,
  saveQuizProgress,
  readQuizSession,
} from '../use-quiz-persistence';

const SESSION_ID = '0198d633-48df-7ca8-b728-c4339d29db47';
const EVENT_ID = '0198d633-0000-7000-8000-000000000002';
const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('hardened quiz session client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQuizStore.getState().reset();
    useQuizStore.getState().setSessionId(SESSION_ID);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(EVENT_ID);
    mockCaptureAttributionParams.mockReturnValue(null);
  });

  it('creates the session through the Quiz API namespace', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          session: { id: SESSION_ID, revision: 0, currentStepId: null },
        },
        201,
      ),
    );

    await expect(createQuizSession({ sessionId: SESSION_ID, locale: 'lt' })).resolves.toEqual({
      id: SESSION_ID,
      revision: 0,
      currentStepId: null,
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/quiz/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, locale: 'lt', source: 'quiz' }),
    });
  });

  it('returns no persistent session when the backend filters a known crawler', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      createQuizSession({ sessionId: SESSION_ID, locale: 'lt' }),
    ).resolves.toBeNull();
  });

  it('attaches captured campaign attribution when creating a quiz session', async () => {
    const attribution = {
      first_touch: {
        utm_source: 'facebook',
        utm_campaign: 'summer',
        fbclid: 'click-1',
        landing_url: 'https://funnel.example/en/quiz?utm_source=facebook',
      },
      last_touch: {
        utm_source: 'facebook',
        utm_campaign: 'summer',
        fbclid: 'click-1',
      },
      fbc: 'fb.1.1789113600000.click-1',
      fbp: 'fb.1.1789113600000.browser-1',
    };
    mockCaptureAttributionParams.mockReturnValue(attribution);
    mockFetch.mockResolvedValue(
      jsonResponse({ session: { id: SESSION_ID, revision: 0, currentStepId: null } }, 201),
    );

    await createQuizSession({ sessionId: SESSION_ID, locale: 'en' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.attribution).toEqual(attribution);
  });

  it('deduplicates concurrent creation for the same client-generated session id', async () => {
    let resolveCreate!: (response: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const first = createQuizSession({ sessionId: SESSION_ID, locale: 'lt' });
    const second = createQuizSession({ sessionId: SESSION_ID, locale: 'lt' });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    resolveCreate(
      jsonResponse(
        { session: { id: SESSION_ID, revision: 0, currentStepId: null } },
        201,
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: SESSION_ID, revision: 0, currentStepId: null },
      { id: SESSION_ID, revision: 0, currentStepId: null },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a resumable session through the authorized read endpoint', async () => {
    const session = {
      id: SESSION_ID,
      status: 'active',
      current_step_id: 'step2',
      quiz_answers: { gender: 'female' },
      quiz_result: null,
      result_segment: null,
      quiz_variant: 'boilerplate-v1',
      funnel_variant: 'main-v1',
      locale: 'lt',
      revision: 2,
      completed_at: null,
    };
    mockFetch.mockResolvedValue(jsonResponse(session));

    await expect(readQuizSession(SESSION_ID)).resolves.toEqual(session);
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/quiz/session/read?sessionId=${encodeURIComponent(SESSION_ID)}`,
      { method: 'GET', headers: { Accept: 'application/json' } },
    );
  });

  it('saves the complete answer state and milestone through the Quiz save API', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, revision: 1, currentStepId: 'step2', status: 'active' }),
    );

    await saveQuizProgress(SESSION_ID, 'step2', { gender: 'female' }, {
      locale: 'lt',
      event: {
        type: 'step_completed',
        stepNumber: 1,
        metadata: { step_id: 'step1' },
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/quiz/session/save');
    expect(body).toEqual({
      sessionId: SESSION_ID,
      expectedRevision: 0,
      currentStepId: 'step2',
      answers: { gender: 'female' },
      locale: 'lt',
      event: {
        eventId: EVENT_ID,
        type: 'step_completed',
        stepNumber: 1,
        metadata: { step_id: 'step1' },
      },
    });
    expect(useQuizStore.getState().revision).toBe(1);
  });

  it('serializes rapid saves and uses the revision returned by the previous save', async () => {
    let resolveFirst!: (response: Response) => void;
    mockFetch
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, revision: 2, currentStepId: 'step3', status: 'active' }),
      );

    const first = saveQuizProgress(SESSION_ID, 'step2', { gender: 'female' });
    const second = saveQuizProgress(SESSION_ID, 'step3', {
      gender: 'female',
      primaryGoal: 'a',
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    resolveFirst(
      jsonResponse({ ok: true, revision: 1, currentStepId: 'step2', status: 'active' }),
    );
    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(firstBody.expectedRevision).toBe(0);
    expect(secondBody.expectedRevision).toBe(1);
    expect(useQuizStore.getState().revision).toBe(2);
  });

  it('reconciles one stale revision and retries without dropping local answers', async () => {
    useQuizStore.getState().setStepAnswer('gender', 'female');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'STALE_SESSION_REVISION',
              message: 'Newer quiz progress has already been saved.',
            },
            currentRevision: 3,
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: SESSION_ID,
          status: 'active',
          current_step_id: 'step2',
          quiz_answers: { primaryGoal: 'a' },
          quiz_result: null,
          result_segment: null,
          quiz_variant: 'boilerplate-v1',
          funnel_variant: 'main-v1',
          locale: 'en',
          revision: 3,
          completed_at: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, revision: 4, currentStepId: 'step2', status: 'active' }),
      );

    await saveQuizProgress(SESSION_ID, 'step2', { gender: 'female' });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(retryBody.expectedRevision).toBe(3);
    expect(retryBody.answers).toEqual({ primaryGoal: 'a', gender: 'female' });
    expect(useQuizStore.getState().revision).toBe(4);
  });

  it('recreates a client-minted session when its offline create request was lost', async () => {
    useQuizStore.getState().setStepAnswer('gender', 'female');
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'SESSION_NOT_FOUND', message: 'Quiz session was not found.' } },
          404,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { session: { id: SESSION_ID, revision: 0, currentStepId: null } },
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, revision: 1, currentStepId: 'step2', status: 'active' }),
      );

    await saveQuizProgress(SESSION_ID, 'step2', { gender: 'female' }, { locale: 'en' });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/quiz/session/save',
      '/api/quiz/session/create',
      '/api/quiz/session/save',
    ]);
    const recoveredBody = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(recoveredBody.answers).toEqual({ gender: 'female' });
    expect(recoveredBody.expectedRevision).toBe(0);
  });

  it('captures email, consent, answers, and the lead milestone in one save', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ok: true, revision: 1, currentStepId: 'step6', status: 'active' }),
    );

    await expect(
      captureLeadRecord(
        SESSION_ID,
        'test@example.com',
        { email: 'test@example.com', userEmail: 'test@example.com' },
        {
          consentGivenAt: '2026-09-10T10:00:00.000Z',
          consentVersion: '2026-09-01',
          marketingConsent: true,
        },
        'en',
        'step6',
        6,
      ),
    ).resolves.toEqual({ success: true });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      expectedRevision: 0,
      currentStepId: 'step6',
      email: 'test@example.com',
      consentVersion: '2026-09-01',
      marketingConsent: true,
      event: {
        eventId: EVENT_ID,
        type: 'lead_captured',
        stepNumber: 6,
        metadata: {},
      },
    });
  });

  it('completes using the latest stored revision', async () => {
    useQuizStore.setState({ revision: 7 });
    mockFetch.mockResolvedValue(
      jsonResponse({
        sessionId: SESSION_ID,
        status: 'completed',
        revision: 8,
        resultSegment: 'a',
        result: { score_version: 'boilerplate-v1', profile: 'a' },
        completedAt: '2026-09-10T10:05:00.000Z',
      }),
    );

    await expect(completeQuizSession(SESSION_ID)).resolves.toMatchObject({
      status: 'completed',
      revision: 8,
      resultSegment: 'a',
    });
    expect(mockFetch).toHaveBeenCalledWith('/api/quiz/session/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, expectedRevision: 7 }),
    });
  });
});
