import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const {
  mockUseQuizStore,
  mockQuizStoreState,
  mockUseAnalytics,
  mockUseQuizHydration,
  mockUseRouter,
  mockTrack,
  mockSetSessionId,
  mockRestoreSession,
  mockUseLocale,
  mockCreateQuizSession,
  mockReadQuizSession,
  MockQuizSessionApiError,
} = vi.hoisted(() => {
  class MockQuizSessionApiError extends Error {
    constructor(public status: number) {
      super('Quiz session API error');
    }
  }
  const mockSetSessionId = vi.fn();
  const mockRestoreSession = vi.fn();
  const mockQuizStoreState = {
    isComplete: false,
    sessionId: null as string | null,
    revision: 0,
    hasUnsavedProgress: false,
    currentStepId: 'step1',
    setSessionId: mockSetSessionId,
    restoreSession: mockRestoreSession,
    completeQuiz: vi.fn(),
    answers: {} as Record<string, string | string[] | number>,
    reset: vi.fn(),
  };
  const mockUseQuizStore = Object.assign(vi.fn(), {
    getState: vi.fn(() => mockQuizStoreState),
  });

  return {
    mockUseQuizStore,
    mockQuizStoreState,
    mockUseAnalytics: vi.fn(),
    mockUseQuizHydration: vi.fn(),
    mockUseRouter: vi.fn(),
    mockTrack: vi.fn(),
    mockSetSessionId,
    mockRestoreSession,
    mockUseLocale: vi.fn(() => 'en'),
    mockCreateQuizSession: vi.fn(),
    mockReadQuizSession: vi.fn(),
    MockQuizSessionApiError,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: mockUseRouter,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@repo/i18n/navigation', () => ({ useRouter: mockUseRouter }));

vi.mock('next-intl', () => ({
  useLocale: () => mockUseLocale(),
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

vi.mock('@/stores/quiz-store', () => ({ useQuizStore: mockUseQuizStore }));
vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({
  useQuizHydration: mockUseQuizHydration,
}));
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: mockUseAnalytics,
}));

vi.mock('@/features/quiz/hooks/use-quiz-navigation', () => ({
  useQuizNavigation: () => ({
    currentStep: { stepId: 'step1', type: 'radio', phase: 'phases.start', storeAs: 'goal' },
    stepPosition: 1,
    totalSteps: 7,
    direction: 'forward',
    canGoBack: false,
    goToStep: vi.fn(),
    goToStepReplace: vi.fn(),
    goBack: vi.fn(),
    setStepAnswer: vi.fn(),
    answers: {},
    answerLabels: {},
    resolvedCopy: (template: string) => template,
  }),
}));

vi.mock('@/features/quiz/hooks/use-image-prefetch', () => ({ useImagePrefetch: vi.fn() }));
vi.mock('@/features/quiz/config/quiz-config', () => ({
  quizConfig: { totalSteps: 7, stepPositions: { step1: 1 } },
  quizStepMap: {},
  FIRST_STEP_ID: 'step1',
  TERMINAL_STEP_TYPES: new Set(['loading_screen', 'trial_price']),
}));

const mockResetSessionGate = vi.fn();
const mockMarkSessionReady = vi.fn();
vi.mock('@/features/quiz/lib/session-ready', () => ({
  resetSessionGate: mockResetSessionGate,
  markSessionReady: mockMarkSessionReady,
  waitForSession: () => Promise.resolve(),
}));

vi.mock('../quiz-progress-header', () => ({
  QuizProgressHeader: () => <div data-testid="quiz-progress-header" />,
}));
vi.mock('../step-transition', () => ({
  StepTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../steps/radio-step', () => ({ RadioStep: () => <div data-testid="radio-step" /> }));
vi.mock('../steps/multi-select-step', () => ({ MultiSelectStep: () => <div /> }));
vi.mock('../steps/input-group-step', () => ({ InputGroupStep: () => <div /> }));
vi.mock('../steps/loading-screen-step', () => ({ LoadingScreenStep: () => <div /> }));
vi.mock('../steps/email-capture-step', () => ({ EmailCaptureStep: () => <div /> }));

vi.mock('@/features/quiz/hooks/use-quiz-persistence', () => {
  return {
    QuizSessionApiError: MockQuizSessionApiError,
    captureLeadRecord: vi.fn(),
    completeQuizSession: vi.fn(),
    createQuizSession: mockCreateQuizSession,
    saveQuizProgress: vi.fn(() => Promise.resolve({ ok: true, revision: 1 })),
    readQuizSession: mockReadQuizSession,
  };
});

vi.mock('@/features/analytics/lib/posthog', () => ({
  identifyPostHogUser: vi.fn(),
  capturePostHogEvent: vi.fn(),
}));
vi.mock('@/features/analytics/lib/hash-email', () => ({ hashEmail: vi.fn() }));
vi.mock('@/features/analytics/lib/gtm', () => ({ pushDataLayerEvent: vi.fn() }));
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (store: { setStage: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setStage: vi.fn() }),
}));

describe('QuizPage session bootstrap', () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLocale.mockReturnValue('en');
    mockQuizStoreState.isComplete = false;
    mockQuizStoreState.sessionId = null;
    mockQuizStoreState.revision = 0;
    mockQuizStoreState.hasUnsavedProgress = false;
    mockQuizStoreState.currentStepId = 'step1';
    mockQuizStoreState.answers = {};
    mockUseQuizStore.mockImplementation((selector) => selector(mockQuizStoreState));
    mockUseQuizHydration.mockReturnValue(true);
    mockUseAnalytics.mockReturnValue({ track: mockTrack });
    mockUseRouter.mockReturnValue({ replace: vi.fn(), push: vi.fn() });
    mockCreateQuizSession.mockResolvedValue({
      id: 'fresh-session-id',
      revision: 0,
      currentStepId: null,
    });

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: vi.fn(() => 'fresh-session-id') },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  it('creates a fresh authorized backend session when no local session exists', async () => {
    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockSetSessionId).toHaveBeenCalledWith('fresh-session-id');
      expect(mockCreateQuizSession).toHaveBeenCalledWith({
        sessionId: 'fresh-session-id',
        locale: 'en',
      });
      expect(mockRestoreSession).toHaveBeenCalledWith({
        id: 'fresh-session-id',
        currentStepId: null,
        answers: {},
        revision: 0,
        isComplete: false,
        hasUnsavedProgress: false,
      });
    });
  });

  it('tracks quiz_started only after the backend creates the session', async () => {
    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('quiz_started', {
        session_id: 'fresh-session-id',
      });
    });
  });

  it('renders without persisting or tracking when a known Meta crawler is filtered', async () => {
    mockCreateQuizSession.mockResolvedValue(null);
    const { QuizPage } = await import('../quiz-page');
    const { findByTestId } = render(<QuizPage />);

    expect(await findByTestId('radio-step')).toBeInTheDocument();
    expect(mockQuizStoreState.reset).toHaveBeenCalled();
    expect(mockRestoreSession).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalledWith('quiz_started', expect.anything());
  });

  it('resumes an existing session through the authorized read endpoint', async () => {
    mockQuizStoreState.sessionId = 'existing-session-id';
    mockReadQuizSession.mockResolvedValue({
      id: 'existing-session-id',
      status: 'active',
      current_step_id: 'step2',
      quiz_answers: { gender: 'female' },
      quiz_result: null,
      result_segment: null,
      quiz_variant: 'boilerplate-v1',
      funnel_variant: 'main-v1',
      locale: 'en',
      revision: 2,
      completed_at: null,
    });

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockReadQuizSession).toHaveBeenCalledWith('existing-session-id');
      expect(mockCreateQuizSession).not.toHaveBeenCalled();
      expect(mockRestoreSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'existing-session-id',
          currentStepId: 'step2',
          answers: { gender: 'female' },
          revision: 2,
        }),
      );
    });
  });

  it('recreates a missing locally-minted session with the same id', async () => {
    mockQuizStoreState.sessionId = 'missing-session-id';
    mockReadQuizSession.mockRejectedValue(new MockQuizSessionApiError(404));
    mockCreateQuizSession.mockResolvedValue({
      id: 'missing-session-id',
      revision: 0,
      currentStepId: null,
    });

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockCreateQuizSession).toHaveBeenCalledWith({
        sessionId: 'missing-session-id',
        locale: 'en',
      });
      expect(mockRestoreSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'missing-session-id', revision: 0 }),
      );
    });
  });

  it('does not take over an inaccessible session id', async () => {
    mockQuizStoreState.sessionId = 'other-browser-session-id';
    mockReadQuizSession.mockRejectedValue(new MockQuizSessionApiError(403));

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockQuizStoreState.reset).toHaveBeenCalled();
      expect(mockCreateQuizSession).toHaveBeenCalledWith({
        sessionId: 'fresh-session-id',
        locale: 'en',
      });
      expect(mockCreateQuizSession).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'other-browser-session-id' }),
      );
    });
  });

  it('opens the session-ready gate after initialization settles', async () => {
    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    expect(mockResetSessionGate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockMarkSessionReady).toHaveBeenCalledTimes(1));
  });

  it('does not track quiz_started when backend creation fails', async () => {
    mockCreateQuizSession.mockRejectedValue(new Error('offline'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => expect(mockMarkSessionReady).toHaveBeenCalled());
    expect(mockTrack).not.toHaveBeenCalledWith('quiz_started', expect.anything());
    consoleSpy.mockRestore();
  });

  it('passes the current locale to session creation', async () => {
    mockUseLocale.mockReturnValue('cs');
    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      expect(mockCreateQuizSession).toHaveBeenCalledWith({
        sessionId: 'fresh-session-id',
        locale: 'cs',
      });
    });
  });
});
