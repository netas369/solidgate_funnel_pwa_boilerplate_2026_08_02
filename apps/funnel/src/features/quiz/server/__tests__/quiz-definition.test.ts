import { describe, expect, it } from 'vitest';
import { validateQuizAnswers } from '../quiz-definition';

describe('validateQuizAnswers', () => {
  it('accepts a valid partial snapshot', () => {
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
