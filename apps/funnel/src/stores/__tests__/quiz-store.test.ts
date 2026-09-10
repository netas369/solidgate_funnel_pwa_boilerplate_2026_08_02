import { describe, it, expect, beforeEach } from 'vitest';
import { useQuizStore } from '@/stores/quiz-store';
import { FIRST_STEP_ID } from '@/features/quiz/config/quiz-config';

// The store seeds currentStepId from FIRST_STEP_ID (the quiz config's first
// step), so this suite survives a wholesale config replacement.
const INITIAL_STEP_ID = FIRST_STEP_ID;

describe('useQuizStore', () => {
  beforeEach(() => {
    useQuizStore.setState({
      currentStepId: INITIAL_STEP_ID,
      history: [],
      answers: {},
      answerLabels: {},
      isComplete: false,
      sessionId: null,
      revision: 0,
      hasUnsavedProgress: false,
      authorizedViaPurchase: false,
    });
  });

  it('has correct initial state', () => {
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe(INITIAL_STEP_ID);
    expect(state.history).toEqual([]);
    expect(state.answers).toEqual({});
    expect(state.answerLabels).toEqual({});
    expect(state.isComplete).toBe(false);
    expect(state.sessionId).toBeNull();
    expect(state.revision).toBe(0);
    expect(state.hasUnsavedProgress).toBe(false);
  });

  it('goToStep updates currentStepId and pushes previous to history', () => {
    useQuizStore.getState().goToStep('step2');
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe('step2');
    expect(state.history).toEqual([INITIAL_STEP_ID]);
  });

  it('goToStep chains correctly through multiple steps', () => {
    useQuizStore.getState().goToStep('step2');
    useQuizStore.getState().goToStep('step3');
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe('step3');
    expect(state.history).toEqual([INITIAL_STEP_ID, 'step2']);
  });

  it('goBack pops history and restores previous stepId', () => {
    useQuizStore.getState().goToStep('step2');
    useQuizStore.getState().goBack();
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe(INITIAL_STEP_ID);
    expect(state.history).toEqual([]);
  });

  it('goBack does nothing when history is empty', () => {
    useQuizStore.getState().goBack();
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe(INITIAL_STEP_ID);
    expect(state.history).toEqual([]);
  });

  it('setStepAnswer stores answer by storeAs key', () => {
    useQuizStore.getState().setStepAnswer('motivation', 'patterns');
    expect(useQuizStore.getState().answers.motivation).toBe('patterns');
    expect(useQuizStore.getState().hasUnsavedProgress).toBe(true);
  });

  it('setStepAnswer stores array answers for multi-select', () => {
    useQuizStore.getState().setStepAnswer('focusAreas', ['love', 'career']);
    expect(useQuizStore.getState().answers.focusAreas).toEqual(['love', 'career']);
  });

  it('setStepAnswer stores numeric answers for input_group fields', () => {
    useQuizStore.getState().setStepAnswer('age', 34);
    expect(useQuizStore.getState().answers.age).toBe(34);
  });

  it('setStepAnswer stores label when provided', () => {
    useQuizStore
      .getState()
      .setStepAnswer('lifeFeeling', 'stuck', 'Stuck in the same patterns');
    expect(useQuizStore.getState().answerLabels.lifeFeeling).toBe(
      'Stuck in the same patterns',
    );
  });

  it('setStepAnswer does not overwrite existing labels when label is undefined', () => {
    useQuizStore
      .getState()
      .setStepAnswer('lifeFeeling', 'stuck', 'Stuck in the same patterns');
    useQuizStore.getState().setStepAnswer('lifeFeeling', 'restless');
    expect(useQuizStore.getState().answerLabels.lifeFeeling).toBe(
      'Stuck in the same patterns',
    );
  });

  it('reset returns to initial state', () => {
    useQuizStore.getState().goToStep('step2');
    useQuizStore.getState().setStepAnswer('motivation', 'patterns', 'Patterns');
    useQuizStore.getState().completeQuiz();
    useQuizStore.getState().reset();
    const state = useQuizStore.getState();
    expect(state.currentStepId).toBe(INITIAL_STEP_ID);
    expect(state.history).toEqual([]);
    expect(state.answers).toEqual({});
    expect(state.answerLabels).toEqual({});
    expect(state.isComplete).toBe(false);
  });

  it('setSessionId sets the sessionId', () => {
    useQuizStore.getState().setSessionId('abc-123');
    expect(useQuizStore.getState().sessionId).toBe('abc-123');
  });

  it('completeQuiz sets isComplete to true', () => {
    useQuizStore.getState().completeQuiz();
    expect(useQuizStore.getState().isComplete).toBe(true);
  });

  it('marks progress saved only when the saved values still match local state', () => {
    useQuizStore.getState().setSessionId('session-1');
    useQuizStore.getState().setStepAnswer('motivation', 'patterns');

    useQuizStore.getState().markProgressSaved({
      sessionId: 'session-1',
      currentStepId: INITIAL_STEP_ID,
      answers: { motivation: 'patterns' },
      revision: 1,
    });

    expect(useQuizStore.getState().revision).toBe(1);
    expect(useQuizStore.getState().hasUnsavedProgress).toBe(false);
  });

  it('keeps the unsaved marker when local answers changed during a request', () => {
    useQuizStore.getState().setSessionId('session-1');
    useQuizStore.getState().setStepAnswer('motivation', 'patterns');
    useQuizStore.getState().setStepAnswer('focusAreas', ['career']);

    useQuizStore.getState().markProgressSaved({
      sessionId: 'session-1',
      currentStepId: INITIAL_STEP_ID,
      answers: { motivation: 'patterns' },
      revision: 1,
    });

    expect(useQuizStore.getState().revision).toBe(1);
    expect(useQuizStore.getState().hasUnsavedProgress).toBe(true);
  });

  it('migrates the old pending-save field without losing local progress', async () => {
    const migrate = useQuizStore.persist.getOptions().migrate;
    expect(migrate).toBeDefined();

    const migrated = await migrate?.(
      {
        sessionId: 'session-1',
        hasPendingSnapshot: true,
      },
      0,
    );

    expect(migrated).toMatchObject({
      sessionId: 'session-1',
      hasUnsavedProgress: true,
      persistedAt: expect.any(Number),
    });
    expect(migrated).not.toHaveProperty('hasPendingSnapshot');
  });

  it('discards locally persisted Quiz data after seven days', () => {
    const merge = useQuizStore.persist.getOptions().merge;
    expect(merge).toBeDefined();

    const current = useQuizStore.getState();
    const merged = merge?.(
      {
        sessionId: 'expired-session',
        answers: { sensitiveAnswer: 'expired' },
        currentStepId: 'step2',
        persistedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      },
      current,
    );

    expect(merged).toMatchObject({
      sessionId: null,
      answers: {},
      currentStepId: INITIAL_STEP_ID,
    });
  });

  it('setAuthLinked sets the auth-linked tri-state', () => {
    expect(useQuizStore.getState().authLinked).toBeNull();
    useQuizStore.getState().setAuthLinked(false);
    expect(useQuizStore.getState().authLinked).toBe(false);
    useQuizStore.getState().setAuthLinked(true);
    expect(useQuizStore.getState().authLinked).toBe(true);
  });
});

describe('useQuizStore  -  authorizedViaPurchase (post-purchase OTO gate)', () => {
  beforeEach(() => {
    useQuizStore.getState().reset();
  });

  it('defaults authorizedViaPurchase to false', () => {
    expect(useQuizStore.getState().authorizedViaPurchase).toBe(false);
  });

  it('grantPurchaseAuthorization(sid) sets sessionId + flips authorizedViaPurchase=true atomically', () => {
    useQuizStore.getState().grantPurchaseAuthorization('test-session-abc');
    const s = useQuizStore.getState();
    expect(s.authorizedViaPurchase).toBe(true);
    expect(s.sessionId).toBe('test-session-abc');
    expect(s.isComplete).toBe(false); // grant does NOT fake quiz completion
  });

  it('reset() clears authorizedViaPurchase back to false', () => {
    useQuizStore.getState().grantPurchaseAuthorization('s1');
    expect(useQuizStore.getState().authorizedViaPurchase).toBe(true);
    useQuizStore.getState().reset();
    expect(useQuizStore.getState().authorizedViaPurchase).toBe(false);
    expect(useQuizStore.getState().sessionId).toBeNull();
  });

  it('completeQuiz() does NOT touch authorizedViaPurchase', () => {
    useQuizStore.getState().completeQuiz();
    expect(useQuizStore.getState().authorizedViaPurchase).toBe(false);
    expect(useQuizStore.getState().isComplete).toBe(true);
  });
});
