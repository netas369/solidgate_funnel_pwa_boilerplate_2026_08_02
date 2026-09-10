'use client';

import { useQuizStore } from '@/stores/quiz-store';
import {
  captureAttributionParams,
  captureFunnelSource,
  type AttributionSnapshot,
  type FunnelSource,
} from '@/features/analytics/lib/attribution';

export type QuizAnswers = Record<string, string | string[] | number>;

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string>;
  };
  currentRevision?: number;
}

export class QuizSessionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'QuizSessionApiError';
  }
}

export interface QuizSessionResponse {
  id: string;
  status: 'active' | 'completed' | 'abandoned' | 'expired';
  current_step_id: string | null;
  quiz_answers: QuizAnswers;
  quiz_result: Record<string, unknown> | null;
  result_segment: string | null;
  quiz_variant: string;
  funnel_variant: string;
  source: FunnelSource;
  locale: string;
  revision: number;
  completed_at: string | null;
}

export interface QuizSaveEvent {
  type: 'step_completed' | 'lead_captured';
  stepNumber?: number | null;
  metadata?: Record<string, unknown>;
}

interface QuizSaveOptions {
  locale?: string;
  email?: string;
  consent?: {
    consentGivenAt: string;
    consentVersion: string;
    marketingConsent: boolean;
  };
  event?: QuizSaveEvent;
}

interface QuizSaveResponse {
  ok: true;
  revision: number;
  currentStepId: string | null;
  status: 'active';
}

export interface CompletionResponse {
  sessionId: string;
  status: 'completed';
  revision: number;
  resultSegment: string;
  result: Record<string, unknown>;
  completedAt: string | null;
}

const sessionQueues = new Map<string, Promise<unknown>>();
type CreatedQuizSession = {
  id: string;
  revision: number;
  currentStepId: string | null;
  quizVariant: string;
  funnelVariant: string;
  source: FunnelSource;
};
const sessionCreations = new Map<
  string,
  Promise<CreatedQuizSession | null>
>();

async function readApiError(response: Response): Promise<QuizSessionApiError> {
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
  return new QuizSessionApiError(
    response.status,
    body.error?.code ?? 'REQUEST_FAILED',
    body.error?.message ?? (response.statusText || 'Quiz session request failed.'),
    body.currentRevision,
  );
}

async function requireJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await readApiError(response);
  return (await response.json()) as T;
}

function enqueueSessionTask<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(task);
  sessionQueues.set(sessionId, queued);
  void queued
    .finally(() => {
      if (sessionQueues.get(sessionId) === queued) sessionQueues.delete(sessionId);
    })
    .catch(() => undefined);
  return queued;
}

export async function createQuizSession(input: {
  sessionId?: string;
  locale: string;
  attribution?: AttributionSnapshot;
  source?: FunnelSource;
}): Promise<CreatedQuizSession | null> {
  const create = async () => {
    const attribution = input.attribution ?? captureAttributionParams() ?? undefined;
    const response = await fetch('/api/quiz/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(attribution ? { attribution } : {}),
        locale: input.locale,
        source: input.source ?? captureFunnelSource(),
      }),
    });
    // Known Meta crawlers receive the quiz HTML but no persistent session.
    // Returning null keeps their page render quiet while suppressing local,
    // database, and third-party quiz_started tracking.
    if (response.status === 204) return null;
    const body = await requireJson<{
      session: CreatedQuizSession;
    }>(response);
    return body.session;
  };

  const sessionId = input.sessionId;
  if (!sessionId) return create();
  const existing = sessionCreations.get(sessionId);
  if (existing) return existing;

  const request = create();
  sessionCreations.set(sessionId, request);
  void request
    .finally(() => {
      if (sessionCreations.get(sessionId) === request) {
        sessionCreations.delete(sessionId);
      }
    })
    .catch(() => undefined);
  return request;
}

export async function readQuizSession(sessionId: string): Promise<QuizSessionResponse> {
  const response = await fetch(`/api/quiz/session/read?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return requireJson<QuizSessionResponse>(response);
}

async function postQuizSave(input: {
  sessionId: string;
  expectedRevision: number;
  currentStepId: string;
  answers: QuizAnswers;
  options: QuizSaveOptions;
  eventId?: string;
}): Promise<QuizSaveResponse> {
  const { consent } = input.options;
  const response = await fetch('/api/quiz/session/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      currentStepId: input.currentStepId,
      answers: input.answers,
      ...(input.options.email ? { email: input.options.email } : {}),
      ...(input.options.locale ? { locale: input.options.locale } : {}),
      ...(consent
        ? {
            consentGivenAt: consent.consentGivenAt,
            consentVersion: consent.consentVersion,
            marketingConsent: consent.marketingConsent,
          }
        : {}),
      ...(input.options.event && input.eventId
        ? {
            event: {
              eventId: input.eventId,
              type: input.options.event.type,
              stepNumber: input.options.event.stepNumber ?? null,
              metadata: input.options.event.metadata ?? {},
            },
          }
        : {}),
    }),
  });
  return requireJson<QuizSaveResponse>(response);
}

/**
 * Queue a complete answer save for one session. Every queued request reads the
 * latest server revision immediately before it runs, so rapid step changes
 * cannot overtake each other. A stale response is reconciled once against an
 * authorized server read; local unsaved answers win over the stored answers.
 */
export function saveQuizProgress(
  sessionId: string,
  currentStepId: string,
  answers: QuizAnswers,
  options: QuizSaveOptions = {},
): Promise<QuizSaveResponse> {
  const eventId = options.event ? globalThis.crypto.randomUUID() : undefined;
  const submittedAnswers = { ...answers };

  return enqueueSessionTask(sessionId, async () => {
    const state = useQuizStore.getState();
    if (state.sessionId !== sessionId) {
      throw new QuizSessionApiError(409, 'SESSION_CHANGED', 'The active quiz session changed.');
    }

    let answersToSave = submittedAnswers;
    let expectedRevision = state.revision;

    try {
      const saved = await postQuizSave({
        sessionId,
        expectedRevision,
        currentStepId,
        answers: answersToSave,
        options,
        eventId,
      });
      useQuizStore.getState().markProgressSaved({
        sessionId,
        currentStepId,
        answers: answersToSave,
        revision: saved.revision,
      });
      return saved;
    } catch (error) {
      if (
        error instanceof QuizSessionApiError &&
        error.code === 'SESSION_NOT_FOUND' &&
        options.locale
      ) {
        // Session creation may have been the request lost during an offline
        // start. Recreate only the same client-minted ID, receive its signed
        // credential, and then save the locally retained complete answer set.
        const created = await createQuizSession({ sessionId, locale: options.locale });
        if (!created) {
          throw new QuizSessionApiError(
            403,
            'AUTOMATED_TRAFFIC',
            'Automated traffic cannot create a persistent quiz session.',
          );
        }
        answersToSave = useQuizStore.getState().reconcileProgress({
          sessionId,
          answers: submittedAnswers,
          revision: created.revision,
        });
        const recovered = await postQuizSave({
          sessionId,
          expectedRevision: created.revision,
          currentStepId,
          answers: answersToSave,
          options,
          eventId,
        });
        useQuizStore.getState().markProgressSaved({
          sessionId,
          currentStepId,
          answers: answersToSave,
          revision: recovered.revision,
        });
        return recovered;
      }
      if (!(error instanceof QuizSessionApiError) || error.code !== 'STALE_SESSION_REVISION') {
        throw error;
      }
    }

    const serverSession = await readQuizSession(sessionId);
    if (serverSession.status !== 'active') {
      throw new QuizSessionApiError(
        409,
        'SESSION_ALREADY_COMPLETED',
        'Quiz session is no longer active.',
      );
    }
    answersToSave = useQuizStore.getState().reconcileProgress({
      sessionId,
      answers: { ...serverSession.quiz_answers, ...submittedAnswers },
      revision: serverSession.revision,
    });
    expectedRevision = serverSession.revision;

    const saved = await postQuizSave({
      sessionId,
      expectedRevision,
      currentStepId,
      answers: answersToSave,
      options,
      eventId,
    });
    useQuizStore.getState().markProgressSaved({
      sessionId,
      currentStepId,
      answers: answersToSave,
      revision: saved.revision,
    });
    return saved;
  });
}

export function persistSessionLocale(sessionId: string, locale: string): Promise<QuizSaveResponse> {
  const state = useQuizStore.getState();
  return saveQuizProgress(sessionId, state.currentStepId, state.answers, { locale });
}

export async function captureLeadRecord(
  sessionId: string,
  email: string,
  answers: QuizAnswers,
  consent?: { consentGivenAt: string; consentVersion: string; marketingConsent: boolean },
  locale?: string,
  currentStepId?: string,
  stepNumber?: number,
): Promise<{ success: boolean }> {
  const save = () =>
    saveQuizProgress(
      sessionId,
      currentStepId ?? useQuizStore.getState().currentStepId,
      answers,
      {
        email,
        locale,
        consent,
        event: {
          type: 'lead_captured',
          stepNumber: stepNumber ?? null,
          metadata: {},
        },
      },
    );

  try {
    await save();
    return { success: true };
  } catch (firstError) {
    console.error('[lead-capture] First save failed:', firstError);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await save();
      return { success: true };
    } catch (retryError) {
      console.error('[lead-capture] Retry failed:', retryError);
    }
  }

  // The email step stays open with the answers still held by the Quiz store,
  // so a second permanent localStorage copy of the email and answers would add
  // privacy risk without improving recovery.
  return { success: false };
}

export function completeQuizSession(sessionId: string): Promise<CompletionResponse> {
  return enqueueSessionTask(sessionId, async () => {
    const submit = async (expectedRevision: number) => {
      const response = await fetch('/api/quiz/session/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, expectedRevision }),
      });
      return requireJson<CompletionResponse>(response);
    };

    try {
      return await submit(useQuizStore.getState().revision);
    } catch (error) {
      if (!(error instanceof QuizSessionApiError) || error.code !== 'STALE_SESSION_REVISION') {
        throw error;
      }
      const serverSession = await readQuizSession(sessionId);
      if (serverSession.status === 'completed' && serverSession.quiz_result) {
        return {
          sessionId: serverSession.id,
          status: 'completed',
          revision: serverSession.revision,
          resultSegment: serverSession.result_segment ?? '',
          result: serverSession.quiz_result,
          completedAt: serverSession.completed_at,
        };
      }
      return submit(serverSession.revision);
    }
  });
}
