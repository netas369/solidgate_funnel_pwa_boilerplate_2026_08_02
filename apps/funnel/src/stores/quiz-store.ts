'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FIRST_STEP_ID } from '@/features/quiz/config/quiz-config';

interface QuizState {
  currentStepId: string;
  history: string[];
  answers: Record<string, string | string[] | number>;
  answerLabels: Record<string, string | string[]>;
  isComplete: boolean;
  sessionId: string | null;
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
  completeQuiz: () => void;

  // Atomic grant - sets sessionId + flips authorizedViaPurchase=true in one
  // set() so OTO guards never see a mixed intermediate state.
  grantPurchaseAuthorization: (sessionId: string) => void;
}

const initialState = {
  currentStepId: FIRST_STEP_ID,
  history: [] as string[],
  answers: {} as Record<string, string | string[] | number>,
  answerLabels: {} as Record<string, string | string[]>,
  isComplete: false,
  sessionId: null as string | null,
  authLinked: null as boolean | null,
  authorizedViaPurchase: false,
};

export const useQuizStore = create<QuizState>()(
  persist(
    (set) => ({
      ...initialState,

      goToStep: (stepId) =>
        set((state) => ({
          history: [...state.history, state.currentStepId],
          currentStepId: stepId,
        })),

      replaceStep: (stepId) => set({ currentStepId: stepId }),

      goBack: () =>
        set((state) => {
          if (state.history.length === 0) return {};
          const prev = state.history[state.history.length - 1];
          return {
            history: state.history.slice(0, -1),
            currentStepId: prev,
          };
        }),

      restoreNavigation: (stepId, history) => set({ currentStepId: stepId, history }),

      setStepAnswer: (storeAs, value, label) =>
        set((state) => ({
          answers: { ...state.answers, [storeAs]: value },
          answerLabels:
            label !== undefined
              ? { ...state.answerLabels, [storeAs]: label }
              : state.answerLabels,
        })),

      reset: () => set(initialState),

      setSessionId: (id) => set({ sessionId: id }),

      // Atomic grant for the direct-offer post-purchase path. Sets sessionId +
      // authorizedViaPurchase=true in one set() so the OTO guards (which widen
      // to accept authorizedViaPurchase as an alt signal) never see a mixed
      // intermediate state between router.push('/oto/1') and mount.
      grantPurchaseAuthorization: (sessionId) =>
        set({ sessionId, authorizedViaPurchase: true }),

      completeQuiz: () => set({ isComplete: true }),

      setAuthLinked: (value) => set({ authLinked: value }),
    }),
    {
      name: 'quiz-store',
      skipHydration: true,
      partialize: (state) => ({
        currentStepId: state.currentStepId,
        history: state.history,
        answers: state.answers,
        answerLabels: state.answerLabels,
        isComplete: state.isComplete,
        sessionId: state.sessionId,
        authLinked: state.authLinked,
        authorizedViaPurchase: state.authorizedViaPurchase,
      }),
    }
  )
);
