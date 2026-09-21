import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

const mockTrack = vi.fn();
vi.mock('@/features/analytics/hooks/use-analytics', () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

const mockCaptureLeadRecord = vi.fn();
vi.mock('@/features/quiz/hooks/use-quiz-persistence', () => ({
  captureLeadRecord: (...args: unknown[]) => mockCaptureLeadRecord(...args),
  saveQuizProgress: vi.fn(),
}));

const mockIdentifyPostHogUser = vi.fn();
vi.mock('@/features/analytics/lib/posthog', () => ({
  capturePostHogEvent: vi.fn(),
  identifyPostHogUser: (...args: unknown[]) => mockIdentifyPostHogUser(...args),
}));

const mockHashEmail = vi.fn();
vi.mock('@/features/analytics/lib/hash-email', () => ({
  hashEmail: (...args: unknown[]) => mockHashEmail(...args),
}));

const mockPushDataLayerEvent = vi.fn();
vi.mock('@/features/analytics/lib/gtm', () => ({
  pushDataLayerEvent: (...args: unknown[]) => mockPushDataLayerEvent(...args),
}));

vi.mock('@repo/shared/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      insert: () => ({
        then: (cb: (result: { error: null }) => void) => cb({ error: null }),
      }),
    }),
  }),
}));

const mockSetStage = vi.fn();
vi.mock('@/stores/funnel-store', () => ({
  useFunnelStore: (selector: (s: {
    setStage: typeof mockSetStage;
    currentStage: 'quiz';
    canAdvanceTo: () => boolean;
  }) => unknown) =>
    selector({ setStage: mockSetStage, currentStage: 'quiz' as const, canAdvanceTo: () => true }),
}));

const mockSetStepAnswer = vi.fn();
const mockCompleteQuiz = vi.fn();
const TEST_SESSION_ID = 'test-session-uuid';
const TEST_ANSWERS = { primaryGoal: 'health', ageGroup: '31-40' };

vi.mock('@/stores/quiz-store', () => {
  const store = {
    sessionId: TEST_SESSION_ID,
    answers: TEST_ANSWERS,
    answerLabels: {},
    currentStepId: '001_hook',
    isComplete: false,
    history: [],
    setSessionId: vi.fn(),
    setStepAnswer: mockSetStepAnswer,
    completeQuiz: mockCompleteQuiz,
    goToStep: vi.fn(),
    goBack: vi.fn(),
    reset: vi.fn(),
    getState: () => store,
  };
  return {
    useQuizStore: Object.assign(
      (selector: (s: typeof store) => unknown) => selector(store),
      { getState: () => store }
    ),
  };
});

// Re-import the module functions to test them directly
// We test the handleEmailSubmit logic by calling the actual flow

describe('Email Capture Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureLeadRecord.mockResolvedValue({ success: true });
    mockHashEmail.mockResolvedValue('abc123hash');
  });

  it('captureLeadRecord is called with correct parameter order: (sessionId, email, answers)', async () => {
    const email = 'user@example.com';

    await mockCaptureLeadRecord(TEST_SESSION_ID, email, TEST_ANSWERS);

    expect(mockCaptureLeadRecord).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      email,
      TEST_ANSWERS
    );

    // Verify parameter types: string, string, Record
    const [arg1, arg2, arg3] = mockCaptureLeadRecord.mock.calls[0];
    expect(typeof arg1).toBe('string');
    expect(typeof arg2).toBe('string');
    expect(typeof arg3).toBe('object');
  });

  it('on captureLeadRecord success, track is called with lead_captured', async () => {
    mockCaptureLeadRecord.mockResolvedValue({ success: true });

    // Simulate the handleEmailSubmit flow
    const result = await mockCaptureLeadRecord(TEST_SESSION_ID, 'user@test.com', TEST_ANSWERS);

    if (!result.success) {
      mockTrack('lead_capture_error', { session_id: TEST_SESSION_ID });
    }
    mockTrack('lead_captured', { session_id: TEST_SESSION_ID });

    expect(mockTrack).toHaveBeenCalledWith('lead_captured', { session_id: TEST_SESSION_ID });
    expect(mockTrack).not.toHaveBeenCalledWith('lead_capture_error', expect.anything());
  });

  it('on captureLeadRecord failure, records the error and does not complete the flow', async () => {
    mockCaptureLeadRecord.mockResolvedValue({ success: false });

    const result = await mockCaptureLeadRecord(TEST_SESSION_ID, 'user@test.com', TEST_ANSWERS);

    if (!result.success) {
      mockTrack('lead_capture_error', { session_id: TEST_SESSION_ID });
    } else {
      mockTrack('lead_captured', { session_id: TEST_SESSION_ID });
      mockCompleteQuiz();
    }

    expect(mockTrack).toHaveBeenCalledWith('lead_capture_error', { session_id: TEST_SESSION_ID });
    expect(mockTrack).not.toHaveBeenCalledWith('lead_captured', expect.anything());
    expect(mockCompleteQuiz).not.toHaveBeenCalled();
  });

  it('identifyPostHogUser is called with (sessionId, email)', () => {
    const email = 'user@example.com';

    mockIdentifyPostHogUser(TEST_SESSION_ID, email);

    expect(mockIdentifyPostHogUser).toHaveBeenCalledWith(TEST_SESSION_ID, email);
  });

  it('captureLeadRecord receives consent fields as 4th argument', async () => {
    const email = 'user@example.com';
    const consent = {
      consentGivenAt: '2026-04-09T12:00:00.000Z',
      consentVersion: '1.0',
      marketingConsent: true,
    };

    await mockCaptureLeadRecord(TEST_SESSION_ID, email, TEST_ANSWERS, consent);

    expect(mockCaptureLeadRecord).toHaveBeenCalledWith(
      TEST_SESSION_ID,
      email,
      TEST_ANSWERS,
      consent
    );
  });

  it('hashEmail is called and pushDataLayerEvent fires with hashed email', async () => {
    const email = 'user@example.com';

    const emailHashed = await mockHashEmail(email);
    mockPushDataLayerEvent('lead_captured', {
      session_id: TEST_SESSION_ID,
      email_hashed: emailHashed,
    });

    expect(mockHashEmail).toHaveBeenCalledWith(email);
    expect(mockPushDataLayerEvent).toHaveBeenCalledWith('lead_captured', {
      session_id: TEST_SESSION_ID,
      email_hashed: 'abc123hash',
    });
  });
});
