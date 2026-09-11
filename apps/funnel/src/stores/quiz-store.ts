'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FIRST_STEP_ID } from '@/features/quiz/config/quiz-config';

/** See QuizState.pendingStepActivity. Step ids only; never timestamps. */
export interface PendingStepActivity {
  viewed: string[];
  answered: string[];
  skipped: string[];
}

const MAX_PENDING_STEP_ACTIVITY = 200;

const EMPTY_STEP_ACTIVITY: PendingStepActivity = { viewed: [], answered: [], skipped: [] };

interface QuizState {
  currentStepId: string;
  history: string[];
  answers: Record<string, string | string[] | number>;
  answerLabels: Record<string, string | string[]>;
  isComplete: boolean;
  sessionId: string | null;
  quizVariant: string | null;
  funnelVariant: string | null;
  source: string | null;
  revision: number;
  hasUnsavedProgress: boolean;
  /**
   * Un-flushed CRO step activity. Step IDS ONLY — the server stamps every
   * timestamp with now(), so a skewed or hostile client clock cannot move one.
   *
   * `viewed` is a MULTISET: one entry per forward entry, which IS the view
   * counter. `answered` and `skipped` are sets. It is buffered here rather than
   * sent directly so it rides along on the next save_quiz_session_progress
   * call — step activity must never cost an extra request.
   */
  pendingStepActivity: PendingStepActivity;
  authLinked: boolean | null; // null = unknown/not-yet-determined, false = auth linking failed, true = linked

  // Post-purchase OTO authorization for buyers who arrive through a direct
  // offer link and never completed the quiz. Set true (+ sessionId) by
  // OfferPage.handlePaySuccess BEFORE router.push('/oto/1'). The OTO guards
  // accept this as an alternate to the (isComplete && sessionId) signal.
  // Cleared by reset().
  authorizedViaPurchase: boolean;

  setAuthLinked: (value: boolean) => void;

  goToStep: (stepId: string) => void;
  // Like goToStep but does NOT push the current step onto the history stack.
  // Used for transitional screens (e.g. the step-1 loading screen) that the
  // user should never be able to navigate back to.
  replaceStep: (stepId: string) => void;
  goBack: () => void;
  // Sets position and back-stack together, used when a browser Back/Forward
  // press replays a step recorded in the browser's own history entry. Both
  // fields must move in one set() so `canGoBack` never sees a mixed state.
  restoreNavigation: (stepId: string, history: string[]) => void;
  setStepAnswer: (
    storeAs: string,
    value: string | string[] | number,
    label?: string | string[]
  ) => void;
  reset: () => void;
  setSessionId: (id: string) => void;
  restoreSession: (session: {
    id: string;
    currentStepId: string | null;
    answers: Record<string, string | string[] | number>;
    revision: number;
    isComplete: boolean;
    hasUnsavedProgress?: boolean;
    quizVariant?: string | null;
    funnelVariant?: string | null;
    source?: string | null;
  }) => void;
  reconcileProgress: (progress: {
    sessionId: string;
    answers: Record<string, string | string[] | number>;
    revision: number;
  }) => Record<string, string | string[] | number>;
  markProgressSaved: (progress: {
    sessionId: string;
    currentStepId: string | null;
    answers: Record<string, unknown>;
    revision: number;
    stepActivitySent?: PendingStepActivity;
  }) => void;
  recordStepActivity: (delta: Partial<PendingStepActivity>) => void;
  completeQuiz: (revision?: number) => void;

  // Atomic grant - sets sessionId + flips authorizedViaPurchase=true in one
  // set() so OTO guards never see a mixed intermediate state.
  grantPurchaseAuthorization: (sessionId: string) => void;
}

type PersistedQuizState = Partial<QuizState> & {
  persistedAt?: number;
  hasPendingSnapshot?: boolean;
};

const QUIZ_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const initialState = {
  currentStepId: FIRST_STEP_ID,
  history: [] as string[],
  answers: {} as Record<string, string | string[] | number>,
  answerLabels: {} as Record<string, string | string[]>,
  isComplete: false,
  sessionId: null as string | null,
  quizVariant: null as string | null,
  funnelVariant: null as string | null,
  source: null as string | null,
  revision: 0,
  hasUnsavedProgress: false,
  pendingStepActivity: { ...EMPTY_STEP_ACTIVITY } as PendingStepActivity,
  authLinked: null as boolean | null,
  authorizedViaPurchase: false,
};

export const useQuizStore = create<QuizState>()(
  persist<QuizState, [], [], PersistedQuizState>(
    (set) => ({
      ...initialState,

      goToStep: (stepId) =>
        set((state) => ({
          history: [...state.history, state.currentStepId],
          currentStepId: stepId,
          hasUnsavedProgress: true,
        })),

      replaceStep: (stepId) => set({ currentStepId: stepId, hasUnsavedProgress: true }),

      goBack: () =>
        set((state) => {
          if (state.history.length === 0) return {};
          const prev = state.history[state.history.length - 1];
          return {
            history: state.history.slice(0, -1),
            currentStepId: prev,
            hasUnsavedProgress: true,
          };
        }),

      restoreNavigation: (stepId, history) =>
        set({ currentStepId: stepId, history, hasUnsavedProgress: true }),

      setStepAnswer: (storeAs, value, label) =>
        set((state) => ({
          answers: { ...state.answers, [storeAs]: value },
          hasUnsavedProgress: true,
          answerLabels:
            label !== undefined
              ? { ...state.answerLabels, [storeAs]: label }
              : state.answerLabels,
        })),

      reset: () => set(initialState),

      setSessionId: (id) => set({ sessionId: id, revision: 0 }),

      restoreSession: ({
        id,
        currentStepId,
        answers,
        revision,
        isComplete,
        hasUnsavedProgress = false,
        quizVariant,
        funnelVariant,
        source,
      }) =>
        set((state) => ({
          sessionId: id,
          currentStepId: currentStepId ?? state.currentStepId,
          history: currentStepId === state.currentStepId ? state.history : [],
          answers,
          revision,
          isComplete,
          hasUnsavedProgress,
          ...(quizVariant !== undefined ? { quizVariant } : {}),
          ...(funnelVariant !== undefined ? { funnelVariant } : {}),
          ...(source !== undefined ? { source } : {}),
        })),

      reconcileProgress: ({ sessionId, answers, revision }) => {
        let reconciled = answers;
        set((state) => {
          if (state.sessionId !== sessionId) return {};
          reconciled = { ...answers, ...state.answers };
          return {
            answers: reconciled,
            revision,
            hasUnsavedProgress: true,
          };
        });
        return reconciled;
      },

      markProgressSaved: ({ sessionId, currentStepId, answers, revision, stepActivitySent }) =>
        set((state) => {
          if (state.sessionId !== sessionId) return {};
          const savedCurrentState =
            (currentStepId === null || state.currentStepId === currentStepId) &&
            JSON.stringify(state.answers) === JSON.stringify(answers);
          // Subtract EXACTLY what went over the wire rather than clearing the
          // buffer, so activity recorded WHILE the request was in flight is not
          // thrown away. `viewed` is an append-only log, so the sent prefix is
          // what was consumed. Same care as the hasUnsavedProgress guard above.
          let pendingStepActivity = state.pendingStepActivity;
          if (stepActivitySent) {
            const sentAnswered = new Set(stepActivitySent.answered);
            const sentSkipped = new Set(stepActivitySent.skipped);
            pendingStepActivity = {
              viewed: state.pendingStepActivity.viewed.slice(stepActivitySent.viewed.length),
              answered: state.pendingStepActivity.answered.filter((id) => !sentAnswered.has(id)),
              skipped: state.pendingStepActivity.skipped.filter((id) => !sentSkipped.has(id)),
            };
          }
          return {
            revision,
            pendingStepActivity,
            ...(savedCurrentState ? { hasUnsavedProgress: false } : {}),
          };
        }),

      // Buffer only — the caller's saveQuizProgress flushes it on the SAME
      // request. Deliberately does NOT set hasUnsavedProgress: this is
      // diagnostics, and tripping that flag would make the unsaved-progress
      // guard fire for pure telemetry.
      recordStepActivity: (delta) =>
        set((state) => {
          const current = state.pendingStepActivity;
          // Duplicates in `viewed` are kept — they are the view counter. The
          // cap drops the OLDEST views, which are the least interesting.
          const viewed = [...current.viewed, ...(delta.viewed ?? [])].slice(
            -MAX_PENDING_STEP_ACTIVITY,
          );
          const answered = [...new Set([...current.answered, ...(delta.answered ?? [])])];
          const skipped = [...new Set([...current.skipped, ...(delta.skipped ?? [])])];
          return { pendingStepActivity: { viewed, answered, skipped } };
        }),

      // Atomic grant for the direct-offer post-purchase path. Sets sessionId +
      // authorizedViaPurchase=true in one set() so the OTO guards (which widen
      // to accept authorizedViaPurchase as an alt signal) never see a mixed
      // intermediate state between router.push('/oto/1') and mount.
      grantPurchaseAuthorization: (sessionId) =>
        set({ sessionId, authorizedViaPurchase: true }),

      completeQuiz: (revision) =>
        set((state) => ({
          isComplete: true,
          hasUnsavedProgress: false,
          revision: revision ?? state.revision,
        })),

      setAuthLinked: (value) => set({ authLinked: value }),
    }),
    {
      name: 'quiz-store',
      version: 4,
      migrate: (persistedState, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return {};
        }

        const legacy = persistedState as PersistedQuizState;
        const { hasPendingSnapshot, ...current } = legacy;
        return {
          ...current,
          persistedAt: Date.now(),
          ...(version === 0
            ? {
                hasUnsavedProgress:
                  hasPendingSnapshot ?? legacy.hasUnsavedProgress ?? false,
              }
            : {}),
        };
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState as PersistedQuizState;
        if (
          typeof persisted.persistedAt === 'number' &&
          Date.now() - persisted.persistedAt > QUIZ_STORAGE_TTL_MS
        ) {
          return currentState;
        }
        const rest = { ...persisted };
        delete rest.persistedAt;
        delete rest.hasPendingSnapshot;
        return { ...currentState, ...rest };
      },
      skipHydration: true,
      partialize: (state) => ({
        currentStepId: state.currentStepId,
        history: state.history,
        answers: state.answers,
        answerLabels: state.answerLabels,
        isComplete: state.isComplete,
        sessionId: state.sessionId,
        quizVariant: state.quizVariant,
        funnelVariant: state.funnelVariant,
        source: state.source,
        revision: state.revision,
        hasUnsavedProgress: state.hasUnsavedProgress,
        pendingStepActivity: state.pendingStepActivity,
        authLinked: state.authLinked,
        authorizedViaPurchase: state.authorizedViaPurchase,
        persistedAt: Date.now(),
      }),
    }
  )
);
