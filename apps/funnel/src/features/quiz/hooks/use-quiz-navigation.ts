'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuizStore } from '@/stores/quiz-store';
import { quizConfig, quizStepMap } from '@/features/quiz/config/quiz-config';
import type { QuizStep } from '@/features/quiz/config/quiz-schema';
import { persistSessionSnapshot } from './use-quiz-persistence';
import { useAnalytics } from '@/features/analytics/hooks/use-analytics';
import { trackFunnelEvent } from '@/features/quiz/lib/track-funnel-event';
import { genderOf, resolveGenderTokens } from '@/features/quiz/lib/templated-text';

/**
 * Resolves {{variableName}} template strings against stored answer labels and
 * `<g>masc|fem</g>` gender forms against the selected gender.
 */
function buildCopyResolver(
  answers: Record<string, string | string[] | number>,
  answerLabels: Record<string, string | string[]>
) {
  const gender = genderOf(answers as Record<string, unknown>);
  return (template: string): string =>
    resolveGenderTokens(template, gender).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const label = answerLabels[key];
      if (Array.isArray(label)) return label.join(', ');
      if (label) return label;
      const raw = answers[key];
      if (Array.isArray(raw)) return raw.join(', ');
      return raw !== undefined ? String(raw) : key;
    });
}

/**
 * Browser-history bridge.
 *
 * The quiz lives at a single URL, so without this every step shared one history
 * entry and a browser Back press jumped clear out of the quiz. Each forward
 * move now writes an entry carrying the step and the back-stack; a Back or
 * Forward press replays that entry into the store, so the browser buttons and
 * the in-quiz arrow always agree.
 *
 * The marker is merged into the App Router's own history state rather than
 * replacing it — Next reads that object on popstate, and clobbering it breaks
 * client navigation (same care as the OTO return flow in charge-oto.ts).
 */
const QUIZ_NAV_KEY = '__quizNav';

interface QuizNavEntry {
  stepId: string;
  stack: string[];
}

function readNavEntry(state: unknown): QuizNavEntry | null {
  const marker = (state as Record<string, unknown> | null | undefined)?.[QUIZ_NAV_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const { stepId, stack } = marker as Partial<QuizNavEntry>;
  return typeof stepId === 'string' && Array.isArray(stack) ? { stepId, stack } : null;
}

function writeNavEntry(mode: 'push' | 'replace', entry: QuizNavEntry) {
  if (typeof window === 'undefined') return;
  const merged = { ...(window.history.state ?? {}), [QUIZ_NAV_KEY]: entry };
  // No URL argument — the quiz keeps its single clean /quiz address.
  if (mode === 'push') window.history.pushState(merged, '');
  else window.history.replaceState(merged, '');
}

interface UseQuizNavigationReturn {
  currentStep: QuizStep;
  stepPosition: number;
  totalSteps: number;
  direction: 'forward' | 'backward';
  canGoBack: boolean;
  goToStep: (stepId: string) => void;
  goToStepReplace: (stepId: string) => void;
  goBack: () => void;
  setStepAnswer: (
    storeAs: string,
    value: string | string[] | number,
    label?: string | string[]
  ) => void;
  answers: Record<string, string | string[] | number>;
  answerLabels: Record<string, string | string[]>;
  resolvedCopy: (template: string) => string;
}

// locale is threaded from the page (it owns the next-intl context) so every
// step snapshot can recreate an orphaned session row; see persistSessionSnapshot.
export function useQuizNavigation(locale?: string): UseQuizNavigationReturn {
  const currentStepId = useQuizStore((s) => s.currentStepId);
  const history = useQuizStore((s) => s.history);
  const answers = useQuizStore((s) => s.answers);
  const answerLabels = useQuizStore((s) => s.answerLabels);
  const storeGoToStep = useQuizStore((s) => s.goToStep);
  const storeReplaceStep = useQuizStore((s) => s.replaceStep);
  const storeGoBack = useQuizStore((s) => s.goBack);
  const restoreNavigation = useQuizStore((s) => s.restoreNavigation);
  const setStepAnswer = useQuizStore((s) => s.setStepAnswer);
  const { track } = useAnalytics();
  const sessionId = useQuizStore((s) => s.sessionId);

  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [completedSteps] = useState(() => new Set<string>());
  // How many quiz entries this page-load has pushed. A visitor who resumes at
  // step 13 from localStorage has a full back-stack in the store but only one
  // browser entry, so the in-quiz arrow must not delegate to history.back()
  // until we've actually put something behind us.
  const pushedEntries = useRef(0);

  // Tag the entry the visitor lands on, so a Back press from step 2 has a quiz
  // entry to return to and popstate can tell our entries from the page before.
  useEffect(() => {
    const { currentStepId: stepId, history: stack } = useQuizStore.getState();
    writeNavEntry('replace', { stepId, stack });
    pushedEntries.current = 0;
  }, []);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const entry = readNavEntry(event.state);
      // No marker means we've stepped outside the quiz — let the browser go.
      if (!entry) return;
      const state = useQuizStore.getState();
      if (entry.stepId === state.currentStepId) return;
      const goingBack = entry.stack.length < state.history.length;
      setDirection(goingBack ? 'backward' : 'forward');
      pushedEntries.current = Math.max(0, pushedEntries.current + (goingBack ? -1 : 1));
      restoreNavigation(entry.stepId, entry.stack);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [restoreNavigation]);

  const currentStep = quizStepMap[currentStepId] ?? quizConfig.steps[0];
  const stepPosition = quizConfig.stepPositions[currentStepId] ?? 1;

  const resolvedCopy = useCallback(
    (template: string) => buildCopyResolver(answers, answerLabels)(template),
    [answers, answerLabels]
  );

  // Shared persistence + analytics for any forward move. `answeredStepId` is the
  // step the user is leaving (captured before the store mutates).
  const recordStepAdvance = useCallback(
    (answeredStepId: string) => {
      if (!sessionId) return;
      const answeredStepNum = quizConfig.stepPositions[answeredStepId] ?? 0;

      // Fire-and-forget session snapshot (D-01, D-02)  -  records answered step
      const currentAnswers = useQuizStore.getState().answers;
      persistSessionSnapshot(sessionId, answeredStepId, currentAnswers, locale);

      // Only fire step_completed once per step per session to avoid inflated metrics
      // when users navigate back and forward through already-completed steps.
      if (!completedSteps.has(answeredStepId)) {
        completedSteps.add(answeredStepId);

        // Analytics: step_completed to PostHog + GTM + in-memory (D-08, D-09)
        track('step_completed', { step_id: answeredStepId, step_number: answeredStepNum, session_id: sessionId });

        // Supabase funnel_events insert (ANLYT-01)
        trackFunnelEvent(sessionId, 'step_completed', answeredStepNum, { step_id: answeredStepId });
      }
    },
    [sessionId, track, completedSteps, locale]
  );

  const goToStep = useCallback(
    (stepId: string) => {
      setDirection('forward');
      // Capture the answered step BEFORE mutating store state
      const answeredStepId = useQuizStore.getState().currentStepId;
      storeGoToStep(stepId);
      const next = useQuizStore.getState();
      writeNavEntry('push', { stepId: next.currentStepId, stack: next.history });
      pushedEntries.current += 1;
      recordStepAdvance(answeredStepId);
    },
    [storeGoToStep, recordStepAdvance]
  );

  // Forward move that does NOT record history — the user can't navigate back to
  // the step being left (used by the step-1 loading screen and the auto-advancing
  // checkpoint screens). Replacing the browser entry too keeps Back skipping
  // them instead of dropping the visitor onto a screen that immediately
  // re-advances.
  const goToStepReplace = useCallback(
    (stepId: string) => {
      setDirection('forward');
      const answeredStepId = useQuizStore.getState().currentStepId;
      storeReplaceStep(stepId);
      const next = useQuizStore.getState();
      writeNavEntry('replace', { stepId: next.currentStepId, stack: next.history });
      recordStepAdvance(answeredStepId);
    },
    [storeReplaceStep, recordStepAdvance]
  );

  const goBack = useCallback(() => {
    setDirection('backward');
    if (pushedEntries.current > 0) {
      // Let the browser drive and apply the move via popstate, so the arrow and
      // the browser's own Back button can never disagree about where we are.
      window.history.back();
      return;
    }
    // Nothing pushed this page-load — either we're on the first step, or the
    // visitor resumed mid-quiz so the back-stack predates the browser entry.
    // Move the store instead (it no-ops on an empty stack) and retag the entry.
    storeGoBack();
    const next = useQuizStore.getState();
    writeNavEntry('replace', { stepId: next.currentStepId, stack: next.history });
  }, [storeGoBack]);

  return {
    currentStep,
    stepPosition,
    totalSteps: quizConfig.totalSteps,
    direction,
    canGoBack: history.length > 0,
    goToStep,
    goToStepReplace,
    goBack,
    setStepAnswer,
    answers,
    answerLabels,
    resolvedCopy,
  };
}
