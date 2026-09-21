import type { QuizStep } from './quiz-schema';

/**
 * The answer keys a step may legally write into `sessions.quiz_answers`.
 *
 * The EMPTY array is also the canonical "this step asks nothing" classifier:
 * presentational types (loading_screen, checkpoint, checkpoint_reveal,
 * expert_note, social_wall) fall through to `default`. Three consumers depend
 * on that meaning:
 *
 *   1. answer validation            — server/quiz-definition.ts
 *   2. the CRO definition publisher — scripts/publish-quiz-definition-lib.ts
 *   3. step-activity derivation     — hooks/use-quiz-navigation.ts
 *
 * Keep it in exactly ONE place. A second copy stops agreeing the moment
 * quiz-schema.ts gains a step type, and the failure is silent: the CRO
 * dashboard starts reporting a new question type as a passive screen, which is
 * precisely the branch-vs-drop confusion the catalog exists to remove.
 *
 * This lives under config/ rather than server/ on purpose. It is imported by a
 * 'use client' hook and by a repo-root tsx script, and neither may pull in a
 * server-namespaced module (quiz-definition.ts also carries validateQuizAnswers
 * and the branch walker).
 */
export function allowedKeysForStep(step: QuizStep): string[] {
  switch (step.type) {
    case 'radio':
    case 'picture_select':
    case 'text_select':
    case 'chip_select':
    case 'multi_select':
    case 'email_capture':
    case 'likert':
    case 'slider':
    case 'trial_price':
      return [step.storeAs];
    case 'input_group':
      return step.fields.map((field) => field.storeAs);
    case 'date_wheel':
      return [
        step.storeAs,
        `${step.storeAs}Day`,
        `${step.storeAs}Month`,
        `${step.storeAs}Year`,
      ];
    case 'time_wheel':
      return [step.storeAs, `${step.storeAs}Hour`, `${step.storeAs}Minute`];
    case 'analysis_loader':
      return step.questions.flatMap((question) => (question.storeAs ? [question.storeAs] : []));
    default:
      return [];
  }
}

/**
 * True when the step captures at least one answer key.
 *
 * This is the question-vs-screen distinction the CRO dashboard needs: today
 * `step_completed` fires for auto-advancing screens too (use-quiz-navigation's
 * goToStepReplace), so the event alone cannot tell "answered" from "displayed".
 */
export function isQuestionStep(step: QuizStep): boolean {
  return allowedKeysForStep(step).length > 0;
}
