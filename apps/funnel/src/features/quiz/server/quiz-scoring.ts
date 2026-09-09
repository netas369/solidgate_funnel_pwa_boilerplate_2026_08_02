import type { Json } from '@repo/shared/types/database';
import { QUIZ_VARIANT, type QuizAnswers } from './quiz-definition';

export interface QuizScore {
  segment: string;
  result: Json;
}

/**
 * Deterministic neutral-boilerplate scorer.
 *
 * TODO(new product): replace this mapping with the product's versioned scoring
 * rules. Keep old implementations available for every persisted quiz_variant.
 */
export function scoreQuiz(answers: QuizAnswers): QuizScore {
  const primaryGoal = answers.primaryGoal;
  const segment = typeof primaryGoal === 'string' ? primaryGoal : 'complete';
  const answeredQuestions = Object.values(answers).filter((value) => value !== undefined).length;

  return {
    segment,
    result: {
      score_version: QUIZ_VARIANT,
      profile: segment,
      answered_questions: answeredQuestions,
    },
  };
}
