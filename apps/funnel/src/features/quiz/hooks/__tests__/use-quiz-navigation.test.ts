import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuizNavigation } from '../use-quiz-navigation';

// ─── Hoisted mocks (available inside vi.mock factories) ──────────────────────
const {
  mockGoToStep,
  mockGoBack,
  mockTrack,
  mockState,
  mockRecordStepActivity,
  mockSaveQuizProgress,
} = vi.hoisted(() => {
  const mockGoToStep = vi.fn();
  const mockGoBack = vi.fn();
  const mockSetStepAnswer = vi.fn();
  const mockTrack = vi.fn();
  const mockSaveQuizProgress = vi
    .fn<
      (
        sessionId: string,
        currentStepId: string,
        answers: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{ ok: boolean }>
    >()
    .mockResolvedValue({ ok: true });
  const mockRecordStepActivity =
    vi.fn<
      (delta: { viewed?: string[]; answered?: string[]; skipped?: string[] }) => void
    >();
  const mockState = {
    currentStepId: 'step-a',
    history: [] as string[],
    answers: {} as Record<string, string | string[] | number>,
    answerLabels: {} as Record<string, string | string[]>,
    sessionId: 'test-session-123' as string | null,
    pendingStepActivity: { viewed: [], answered: [], skipped: [] } as {
      viewed: string[];
      answered: string[];
      skipped: string[];
    },
    goToStep: mockGoToStep,
    goBack: mockGoBack,
    setStepAnswer: mockSetStepAnswer,
    recordStepActivity: mockRecordStepActivity,
  };
  return {
    mockGoToStep,
    mockGoBack,
    mockTrack,
    mockState,
    mockSaveQuizProgress,
    mockRecordStepActivity,
  };
});

// ─── Mock the quiz store ───────────────────────────────────────────────────────
vi.mock('@/stores/quiz-store', () => {
  const useQuizStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockState),
    { getState: () => mockState }
  );
  return { useQuizStore };
});

// ─── Mock analytics ──────────────────────────────────────────────────────────
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

// ─── Mock persistence ────────────────────────────────────────────────────────
vi.mock('../use-quiz-persistence', () => ({
  saveQuizProgress: mockSaveQuizProgress,
}));

// ─── Mock quiz config with minimal test steps ──────────────────────────────────
vi.mock('@/features/quiz/config/quiz-config', () => ({
  quizConfig: {
    totalSteps: 3,
    stepPositions: {
      'step-a': 1,
      'step-b': 2,
      'step-c': 3,
      'step-d': 4,
      'step-e': 5,
    },
    steps: [
      {
        stepId: 'step-a',
        phase: 'Phase 1',
        type: 'radio',
        storeAs: 'goal',
        question: 'Question A?',
        options: [
          { label: 'Option 1', value: 'opt1', nextStepId: 'step-b' },
          { label: 'Option 2', value: 'opt2', nextStepId: 'step-c' },
        ],
      },
      {
        stepId: 'step-b',
        phase: 'Phase 1',
        type: 'info_box',
        dynamicCopy: 'You chose {{goal}}.',
        buttonLabel: 'Next',
        nextStepId: 'step-c',
      },
      {
        stepId: 'step-c',
        phase: 'Phase 2',
        type: 'email_capture',
        storeAs: 'userEmail',
        dynamicCopy: 'Enter your email.',
        buttonLabel: 'Submit',
        nextStepId: 'checkout_sales_page',
      },
    ],
  },
  quizStepMap: {
    'step-a': {
      stepId: 'step-a',
      phase: 'Phase 1',
      type: 'radio',
      storeAs: 'goal',
      question: 'Question A?',
      options: [
        { label: 'Option 1', value: 'opt1', nextStepId: 'step-b' },
        { label: 'Option 2', value: 'opt2', nextStepId: 'step-c' },
      ],
    },
    'step-b': {
      stepId: 'step-b',
      phase: 'Phase 1',
      type: 'info_box',
      dynamicCopy: 'You chose {{goal}}.',
      buttonLabel: 'Next',
      nextStepId: 'step-c',
    },
    'step-c': {
      stepId: 'step-c',
      phase: 'Phase 2',
      type: 'email_capture',
      storeAs: 'userEmail',
      dynamicCopy: 'Enter your email.',
      buttonLabel: 'Submit',
      nextStepId: 'checkout_sales_page',
    },
  },
  FIRST_STEP_ID: 'step-a',
}));

describe('useQuizNavigation', () => {
  beforeEach(() => {
    mockState.currentStepId = 'step-a';
    mockState.history = [];
    mockState.answers = {};
    mockState.answerLabels = {};
    mockState.sessionId = 'test-session-123';
    vi.clearAllMocks();
  });

  it('starts with direction forward', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.direction).toBe('forward');
  });

  it('returns correct totalSteps from config', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.totalSteps).toBe(3);
  });

  it('returns currentStep matching currentStepId', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.currentStep.stepId).toBe('step-a');
  });

  it('returns correct stepPosition from config stepPositions map', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.stepPosition).toBe(1);
  });

  it('canGoBack is false when history is empty', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.canGoBack).toBe(false);
  });

  it('canGoBack is true when history has entries', () => {
    mockState.history = ['step-a'];
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.canGoBack).toBe(true);
  });

  it('goToStep calls store goToStep and sets direction to forward', () => {
    const { result } = renderHook(() => useQuizNavigation());
    act(() => {
      result.current.goToStep('step-b');
    });
    expect(mockGoToStep).toHaveBeenCalledWith('step-b');
    expect(result.current.direction).toBe('forward');
  });

  it('goBack calls store goBack and sets direction to backward', () => {
    const { result } = renderHook(() => useQuizNavigation());
    act(() => {
      result.current.goBack();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(result.current.direction).toBe('backward');
  });

  it('resolvedCopy replaces {{variable}} with answerLabel string', () => {
    mockState.answerLabels = { goal: 'Option 1' };
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.resolvedCopy('You chose {{goal}}.')).toBe('You chose Option 1.');
  });

  it('resolvedCopy joins array labels with comma', () => {
    mockState.answerLabels = { cravingTypes: ['Sweets', 'Fast Food'] };
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.resolvedCopy('Cravings: {{cravingTypes}}')).toBe('Cravings: Sweets, Fast Food');
  });

  it('resolvedCopy falls back to raw answer value when no label', () => {
    mockState.answers = { goal: 'opt1' };
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.resolvedCopy('Value: {{goal}}')).toBe('Value: opt1');
  });

  it('resolvedCopy returns key name when no answer or label', () => {
    const { result } = renderHook(() => useQuizNavigation());
    expect(result.current.resolvedCopy('{{unknown}}')).toBe('unknown');
  });

  it('on goToStep, records step_completed analytics for the answered step', () => {
    mockState.currentStepId = 'step-d';

    const { result } = renderHook(() => useQuizNavigation());

    act(() => {
      result.current.goToStep('step-e');
    });

    // Analytics: PostHog/GTM track of the step that was just left.
    expect(mockTrack).toHaveBeenCalledWith('step_completed', {
      step_id: 'step-d',
      step_number: 4,
      session_id: 'test-session-123',
    });
  });

  it('saves the complete answer state for the answered step on goToStep', () => {
    mockState.currentStepId = 'step-d';
    mockState.answers = { goal: 'opt1' };

    const { result } = renderHook(() => useQuizNavigation('lt'));

    act(() => {
      result.current.goToStep('step-e');
    });

    expect(mockSaveQuizProgress).toHaveBeenCalledWith(
      'test-session-123',
      'step-e',
      { goal: 'opt1' },
      {
        locale: 'lt',
        event: {
          type: 'step_completed',
          stepNumber: 4,
          metadata: { step_id: 'step-d' },
        },
      },
    );
  });

  it('does not double-count step_completed when the same step is left twice', () => {
    mockState.currentStepId = 'step-d';

    const { result } = renderHook(() => useQuizNavigation());

    act(() => {
      result.current.goToStep('step-e');
    });
    act(() => {
      result.current.goToStep('step-e');
    });

    // completedSteps de-dupes the durable event while both progress states save.
    const stepDCompletions = mockTrack.mock.calls.filter(
      ([event, payload]) =>
        event === 'step_completed' &&
        (payload as { step_id?: string }).step_id === 'step-d',
    );
    expect(stepDCompletions).toHaveLength(1);
    expect(mockSaveQuizProgress).toHaveBeenCalledTimes(2);
    expect(mockSaveQuizProgress.mock.calls[1]?.[3]).not.toHaveProperty('event');
  });

  it('skips analytics entirely when there is no sessionId', () => {
    mockState.currentStepId = 'step-d';
    mockState.sessionId = '';

    const { result } = renderHook(() => useQuizNavigation());

    act(() => {
      result.current.goToStep('step-e');
    });

    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockSaveQuizProgress).not.toHaveBeenCalled();
  });
});

describe('useQuizNavigation — CRO step activity', () => {
  beforeEach(() => {
    mockState.currentStepId = 'step-a';
    mockState.history = [];
    mockState.answers = {};
    mockState.answerLabels = {};
    mockState.sessionId = 'test-session-123';
    vi.clearAllMocks();
  });

  it('stamps the landing step as viewed on mount', () => {
    renderHook(() => useQuizNavigation());
    expect(mockRecordStepActivity).toHaveBeenCalledWith({ viewed: ['step-a'] });
  });

  it('records the entered step as viewed and the answered step as answered', () => {
    mockState.answers = { goal: 'opt1' };
    const { result } = renderHook(() => useQuizNavigation());
    mockRecordStepActivity.mockClear();

    act(() => result.current.goToStep('step-b'));

    expect(mockRecordStepActivity).toHaveBeenCalledWith({
      viewed: ['step-b'],
      answered: ['step-a'],
      skipped: [],
    });
  });

  it('never buffers an extra request — activity rides along on the same save', () => {
    mockState.answers = { goal: 'opt1' };
    const { result } = renderHook(() => useQuizNavigation());
    mockSaveQuizProgress.mockClear();

    act(() => result.current.goToStep('step-b'));

    expect(mockSaveQuizProgress).toHaveBeenCalledTimes(1);
  });

  it('reports a presentational step as viewed-not-answered', () => {
    // step-b is an info_box: no storeAs, so allowedKeysForStep returns [].
    // This is the case step_completed alone cannot distinguish.
    mockState.currentStepId = 'step-b';
    const { result } = renderHook(() => useQuizNavigation());
    mockRecordStepActivity.mockClear();

    act(() => result.current.goToStep('step-c'));

    expect(mockRecordStepActivity).toHaveBeenCalledWith({
      viewed: ['step-c'],
      answered: [],
      skipped: [],
    });
  });

  it('reports a question left with no stored answer as not answered', () => {
    mockState.answers = {};
    const { result } = renderHook(() => useQuizNavigation());
    mockRecordStepActivity.mockClear();

    act(() => result.current.goToStep('step-b'));

    expect(mockRecordStepActivity).toHaveBeenCalledWith({
      viewed: ['step-b'],
      answered: [],
      skipped: [],
    });
  });

  it('marks an explicit skip as skipped and never as answered', () => {
    mockState.answers = { goal: 'opt1' };
    const { result } = renderHook(() => useQuizNavigation());
    mockRecordStepActivity.mockClear();

    act(() => result.current.goToStep('step-b', { skipped: true }));

    expect(mockRecordStepActivity).toHaveBeenCalledWith({
      viewed: ['step-b'],
      answered: [],
      skipped: ['step-a'],
    });
  });

  it('records nothing beyond the mount stamp when there is no session', () => {
    mockState.sessionId = null;
    const { result } = renderHook(() => useQuizNavigation());
    mockRecordStepActivity.mockClear();

    act(() => result.current.goToStep('step-b'));

    expect(mockRecordStepActivity).not.toHaveBeenCalled();
  });
});
