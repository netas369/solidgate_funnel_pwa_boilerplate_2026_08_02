import { describe, expect, it } from 'vitest';
import { MAX_QUIZ_ANSWERS_BYTES, validateQuizAnswers } from '../quiz-definition';

describe('validateQuizAnswers', () => {
  it('accepts a valid partial answer set', () => {
    expect(validateQuizAnswers({ gender: 'female', primaryGoal: 'a' })).toEqual({
      ok: true,
      errors: {},
    });
  });

  it('rejects unknown keys and invalid configured options', () => {
    const result = validateQuizAnswers({ gender: 'invalid', invented: true });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({
      gender: 'INVALID_OPTION',
      invented: 'UNKNOWN_ANSWER',
    });
  });

  it('rejects wrong answer types and oversized answer state', () => {
    expect(validateQuizAnswers({ gender: true })).toMatchObject({
      ok: false,
      errors: { gender: 'INVALID_OPTION' },
    });
    expect(
      validateQuizAnswers({ fullName: 'x'.repeat(MAX_QUIZ_ANSWERS_BYTES) }),
    ).toEqual({
      ok: false,
      errors: { answers: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('requires answers only from the reachable completion branch', () => {
    const shortBranch = validateQuizAnswers(
      {
        gender: 'female',
        primaryGoal: 'c',
        fullName: 'Alex',
        email: 'alex@example.com',
        userEmail: 'alex@example.com',
      },
      { requireComplete: true },
    );
    expect(shortBranch).toEqual({ ok: true, errors: {} });

    const longBranch = validateQuizAnswers(
      {
        gender: 'female',
        primaryGoal: 'a',
        fullName: 'Alex',
        email: 'alex@example.com',
      },
      { requireComplete: true },
    );
    expect(longBranch.ok).toBe(false);
    expect(longBranch.errors.challenges).toBe('REQUIRED');
  });

  it('rejects an empty required multi-select on completion', () => {
    const result = validateQuizAnswers(
      {
        gender: 'female',
        primaryGoal: 'a',
        challenges: [],
        fullName: 'Alex',
        email: 'alex@example.com',
      },
      { requireComplete: true },
    );
    expect(result.errors.challenges).toBe('REQUIRED');
  });
});
