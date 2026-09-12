import type { Json } from '@repo/shared/types/database';
import { FIRST_STEP_ID, TERMINAL_STEP_TYPES, quizConfig, quizStepMap } from '../config/quiz-config';
import type { QuizStep } from '../config/quiz-schema';
import { allowedKeysForStep } from '../config/step-answer-keys';

// Re-exported from @repo/shared so the CRO app can read them without importing
// this module, which would drag the whole quiz engine into a second app. Every
// existing import site here is unchanged. See packages/shared/src/quiz-variant.ts
// for what the two constants mean and why they are orthogonal.
export { FUNNEL_VARIANT, QUIZ_VARIANT } from '@repo/shared/quiz-variant';
export const MAX_QUIZ_ANSWERS_BYTES = 64 * 1024;

export type QuizAnswers = Record<string, Json | undefined>;

export interface AnswerValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function validateStepAnswer(step: QuizStep, key: string, value: unknown): string | null {
  switch (step.type) {
    case 'radio':
    case 'picture_select':
    case 'text_select':
    case 'chip_select':
      return typeof value === 'string' && step.options.some((option) => option.value === value)
        ? null
        : 'INVALID_OPTION';
    case 'multi_select': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return 'INVALID_TYPE';
      }
      const values = value as string[];
      if (new Set(values).size !== values.length) return 'DUPLICATE_OPTION';
      if (step.maxSelection && values.length > step.maxSelection) return 'TOO_MANY_OPTIONS';
      return values.every((item) => step.options.some((option) => option.value === item))
        ? null
        : 'INVALID_OPTION';
    }
    case 'input_group': {
      const field = step.fields.find((candidate) => candidate.storeAs === key);
      if (!field) return 'UNKNOWN_ANSWER';
      if (field.inputType === 'email') return isEmail(value) ? null : 'INVALID_EMAIL';
      if (field.inputType === 'date') {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? null
          : 'INVALID_DATE';
      }
      if (field.inputType === 'time') {
        return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
          ? null
          : 'INVALID_TIME';
      }
      return isNonEmptyString(value) ? null : 'INVALID_TEXT';
    }
    case 'email_capture':
      return isEmail(value) ? null : 'INVALID_EMAIL';
    case 'date_wheel':
      if (key === step.storeAs) {
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? null
          : 'INVALID_DATE';
      }
      return typeof value === 'string' && /^\d{1,4}$/.test(value)
        ? null
        : 'INVALID_DATE_PART';
    case 'time_wheel':
      if (key === step.storeAs) {
        return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
          ? null
          : 'INVALID_TIME';
      }
      return typeof value === 'string' && /^\d{1,2}$/.test(value)
        ? null
        : 'INVALID_TIME_PART';
    case 'analysis_loader':
      return value === 'yes' || value === 'no' ? null : 'INVALID_OPTION';
    case 'trial_price':
      return typeof value === 'string' && step.tiers.includes(value) ? null : 'INVALID_OPTION';
    case 'likert':
      return typeof value === 'string' && step.points.some((point) => point.value === value)
        ? null
        : 'INVALID_OPTION';
    case 'slider':
      return typeof value === 'string' && step.states.some((state) => state.value === value)
        ? null
        : 'INVALID_OPTION';
    default:
      return 'UNKNOWN_ANSWER';
  }
}

function questionKeys(): Map<string, QuizStep> {
  const result = new Map<string, QuizStep>();
  for (const step of quizConfig.steps) {
    for (const key of allowedKeysForStep(step)) result.set(key, step);
  }
  // The current frontend maintains this compatibility alias after email capture.
  const emailStep = quizConfig.steps.find((step) => step.type === 'email_capture');
  if (emailStep) result.set('userEmail', emailStep);
  return result;
}

export function validateQuizAnswers(
  value: unknown,
  options: { requireComplete?: boolean } = {},
): AnswerValidationResult {
  if (!isPlainObject(value)) return { ok: false, errors: { answers: 'INVALID_OBJECT' } };
  if (serializedBytes(value) > MAX_QUIZ_ANSWERS_BYTES) {
    return { ok: false, errors: { answers: 'PAYLOAD_TOO_LARGE' } };
  }

  const answers = value as Record<string, unknown>;
  const definitions = questionKeys();
  const errors: Record<string, string> = {};

  for (const [key, answer] of Object.entries(answers)) {
    const step = definitions.get(key);
    if (!step) {
      errors[key] = 'UNKNOWN_ANSWER';
      continue;
    }
    const canonicalKey = key === 'userEmail' && step.type === 'email_capture' ? step.storeAs : key;
    const error = validateStepAnswer(step, canonicalKey, answer);
    if (error) errors[key] = error;
  }

  if (options.requireComplete) {
    Object.assign(errors, validateReachableRequiredAnswers(answers));
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

function nextStepId(step: QuizStep, answers: Record<string, unknown>): string | null {
  switch (step.type) {
    case 'radio':
    case 'picture_select':
    case 'text_select':
    case 'chip_select': {
      const answer = answers[step.storeAs];
      const option = step.options.find((candidate) => candidate.value === answer);
      return option?.nextStepId ?? null;
    }
    case 'loading_screen':
    case 'trial_price':
      return null;
    default:
      return 'nextStepId' in step ? step.nextStepId : null;
  }
}

function requiredKeysForStep(step: QuizStep): string[] {
  switch (step.type) {
    case 'radio':
    case 'picture_select':
    case 'text_select':
    case 'chip_select':
    case 'multi_select':
    case 'email_capture':
    case 'date_wheel':
    case 'time_wheel':
    case 'likert':
    case 'slider':
    case 'trial_price':
      return [step.storeAs];
    case 'input_group':
      return step.fields.filter((field) => !field.optional).map((field) => field.storeAs);
    case 'analysis_loader':
      return step.questions.flatMap((question) => (question.storeAs ? [question.storeAs] : []));
    default:
      return [];
  }
}

function validateReachableRequiredAnswers(answers: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  const visited = new Set<string>();
  let stepId: string | null = FIRST_STEP_ID;

  while (stepId) {
    if (visited.has(stepId)) {
      errors.answers = 'QUIZ_BRANCH_CYCLE';
      break;
    }
    visited.add(stepId);
    const step: QuizStep | undefined = quizStepMap[stepId];
    if (!step) {
      errors.answers = 'INVALID_QUIZ_BRANCH';
      break;
    }

    for (const key of requiredKeysForStep(step)) {
      const answer = answers[key];
      if (
        answer === undefined ||
        answer === null ||
        answer === '' ||
        (Array.isArray(answer) && answer.length === 0)
      ) {
        errors[key] = 'REQUIRED';
      }
    }

    if (TERMINAL_STEP_TYPES.has(step.type)) break;
    const next = nextStepId(step, answers);
    if (!next) {
      const branchingKey = 'storeAs' in step && typeof step.storeAs === 'string' ? step.storeAs : 'answers';
      errors[branchingKey] ??= 'REQUIRED';
      break;
    }
    stepId = next;
  }

  return errors;
}

export function isKnownQuizStep(stepId: string | null): boolean {
  return stepId === null || Boolean(quizStepMap[stepId]);
}
