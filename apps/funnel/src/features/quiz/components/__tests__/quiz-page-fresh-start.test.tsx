import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const {
  mockUseQuizStore,
  mockUseAnalytics,
  mockUseQuizHydration,
  mockUseRouter,
  mockTrack,
  mockSetSessionId,
  mockUseLocale,
} = vi.hoisted(() => {
  const mockUseQuizStore = Object.assign(vi.fn(), { getState: vi.fn() });

  return {
    mockUseQuizStore,
    mockUseAnalytics: vi.fn(),
    mockUseQuizHydration: vi.fn(),
    mockUseRouter: vi.fn(),
    mockTrack: vi.fn(),
    mockSetSessionId: vi.fn(),
    mockUseLocale: vi.fn(() => 'en'),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: mockUseRouter,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@repo/i18n/navigation', () => ({
  useRouter: mockUseRouter,
}));

vi.mock('next-intl', () => ({
  useLocale: () => mockUseLocale(),
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

vi.mock('@/stores/quiz-store', () => ({
  useQuizStore: mockUseQuizStore,
}));

vi.mock('@/features/quiz/hooks/use-quiz-hydration', () => ({
  useQuizHydration: mockUseQuizHydration,
}));

vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: mockUseAnalytics,
}));

// QuizPage no longer touches the Supabase client directly — persistence and
// funnel events go through mocked lib modules. This stub is a safety net so any
// transitive import resolves without a real network client.
vi.mock('@repo/shared/supabase/client', () => ({
  createClient: () => {
    throw new Error('QuizPage should not call createClient directly');
  },
}));

vi.mock('@/features/quiz/hooks/use-quiz-navigation', () => ({
  useQuizNavigation: () => ({
    currentStep: { stepId: 'step1', type: 'radio', phase: 'phases.start', storeAs: 'goal' },
    stepPosition: 1,
    totalSteps: 7,
    direction: 1,
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

vi.mock('@/features/quiz/hooks/use-image-prefetch', () => ({
  useImagePrefetch: vi.fn(),
}));

vi.mock('@/features/quiz/config/quiz-config', () => ({
  quizConfig: {
    totalSteps: 7,
    stepPositions: { step1: 1, step2: 2, step3: 3 },
  },
  quizStepMap: {},
  FIRST_STEP_ID: 'step1',
  TERMINAL_STEP_TYPES: new Set(['loading_screen', 'trial_price']),
}));

// trackFunnelEvent now lives in its own lib module; QuizPage calls it after the
// session-persist fetch settles. Stub it so the test can assert it directly.
const mockTrackFunnelEvent = vi.fn();
vi.mock('@/features/quiz/lib/track-funnel-event', () => ({
  trackFunnelEvent: mockTrackFunnelEvent,
}));

// QuizPage opens/closes a module-level session-ready gate around session
// creation. Stub it to assert the gate is driven, without the real promise.
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

vi.mock('../steps/radio-step', () => ({
  RadioStep: () => <div data-testid="radio-step" />,
}));

vi.mock('../steps/multi-select-step', () => ({
  MultiSelectStep: () => <div />,
}));

vi.mock('../steps/input-group-step', () => ({
  InputGroupStep: () => <div />,
}));

vi.mock('../steps/loading-screen-step', () => ({
  LoadingScreenStep: () => <div />,
}));

vi.mock('../steps/email-capture-step', () => ({
  EmailCaptureStep: () => <div />,
}));

vi.mock('@/features/quiz/hooks/use-quiz-persistence', () => ({
  captureLeadRecord: vi.fn(),
  persistSessionSnapshot: vi.fn(),
}));

vi.mock('@/features/analytics/lib/posthog', () => ({
  identifyPostHogUser: vi.fn(),
  capturePostHogEvent: vi.fn(),
}));

vi.mock('@/features/analytics/lib/hash-email', () => ({
  hashEmail: vi.fn(),
}));

vi.mock('@/features/analytics/lib/gtm', () => ({
  pushDataLayerEvent: vi.fn(),
}));

vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (store: { setStage: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ setStage: vi.fn() }),
}));

describe('QuizPage fresh-start bootstrap', () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLocale.mockReturnValue('en');

    const quizStore = {
      isComplete: false,
      sessionId: null as string | null,
      setSessionId: mockSetSessionId,
      completeQuiz: vi.fn(),
      answers: {},
      reset: vi.fn(),
    };

    mockUseQuizStore.mockImplementation((selector: (store: typeof quizStore) => unknown) =>
      selector(quizStore),
    );
    mockUseQuizStore.getState.mockReturnValue(quizStore);

    mockUseQuizHydration.mockReturnValue(true);
    mockUseAnalytics.mockReturnValue({ track: mockTrack });
    mockUseRouter.mockReturnValue({ replace: vi.fn(), push: vi.fn() });

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: vi.fn(() => 'fresh-session-id'),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  it('QuizPage mints a fresh session with crypto.randomUUID and setSessionId when a cleared sessionId reaches /quiz', async () => {
    const { QuizPage } = await import('../quiz-page');

    render(<QuizPage />);

    await waitFor(() => {
      expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
      expect(mockSetSessionId).toHaveBeenCalledWith('fresh-session-id');
    });
  });

  it('QuizPage tracks quiz_started and persists session via /api/session/persist on mount', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { QuizPage } = await import('../quiz-page');

    render(<QuizPage />);

    await waitFor(() => {
      expect(mockTrack).toHaveBeenCalledWith('quiz_started', { session_id: 'fresh-session-id' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/session/persist',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      // funnel_events insert is now routed through the shared trackFunnelEvent lib.
      expect(mockTrackFunnelEvent).toHaveBeenCalledWith('fresh-session-id', 'quiz_started');
    });

    vi.unstubAllGlobals();
  });

  it('drives the session-ready gate: resets it on mount, marks it ready after persist succeeds', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    // The gate is closed synchronously in the mount effect, before session creation.
    expect(mockResetSessionGate).toHaveBeenCalledTimes(1);

    // Once /api/session/persist resolves OK, the gate is opened so funnel
    // events can flush.
    await waitFor(() => {
      expect(mockMarkSessionReady).toHaveBeenCalledTimes(1);
    });

    vi.unstubAllGlobals();
  });

  it('opens the session-ready gate even when /api/session/persist fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, statusText: 'Server Error' });
    vi.stubGlobal('fetch', mockFetch);

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    // Failure path still calls markSessionReady so funnel events degrade to
    // best-effort instead of hanging forever — but no quiz_started funnel event.
    await waitFor(() => {
      expect(mockMarkSessionReady).toHaveBeenCalled();
    });
    expect(mockTrackFunnelEvent).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('sends locale in first session/persist call (Phase 1025, Pitfall 3)', async () => {
    mockUseLocale.mockReturnValue('cs');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      const persistCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/session/persist'),
      );
      expect(persistCall).toBeDefined();
      const body = JSON.parse((persistCall![1] as RequestInit).body as string);
      expect(body).toMatchObject({ locale: 'cs' });
      expect(typeof body.sessionId).toBe('string');
    });

    vi.unstubAllGlobals();
  });

  it('sends en locale in first session/persist call by default', async () => {
    mockUseLocale.mockReturnValue('en');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { QuizPage } = await import('../quiz-page');
    render(<QuizPage />);

    await waitFor(() => {
      const persistCall = mockFetch.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/session/persist'),
      );
      expect(persistCall).toBeDefined();
      const body = JSON.parse((persistCall![1] as RequestInit).body as string);
      expect(body).toMatchObject({ locale: 'en' });
    });

    vi.unstubAllGlobals();
  });
});
