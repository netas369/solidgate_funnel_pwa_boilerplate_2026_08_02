import { describe, expect, it } from 'vitest';
import { quizStepSchema } from '../quiz-schema';
import { allowedKeysForStep, isQuestionStep } from '../step-answer-keys';
import type { QuizStep } from '../quiz-schema';

const QUESTION_TYPES = new Set([
  'radio',
  'picture_select',
  'text_select',
  'chip_select',
  'multi_select',
  'email_capture',
  'likert',
  'slider',
  'trial_price',
  'input_group',
  'date_wheel',
  'time_wheel',
  'analysis_loader',
]);

const SCREEN_TYPES = new Set([
  'loading_screen',
  'checkpoint',
  'checkpoint_reveal',
  'expert_note',
  'social_wall',
]);

describe('allowedKeysForStep', () => {
  it('returns the single storeAs for simple select types', () => {
    expect(allowedKeysForStep({ type: 'radio', storeAs: 'goal' } as QuizStep)).toEqual(['goal']);
  });

  it('returns one key per field for input_group, including optional fields', () => {
    expect(
      allowedKeysForStep({
        type: 'input_group',
        fields: [{ storeAs: 'fullName' }, { storeAs: 'nickname', optional: true }],
      } as QuizStep),
    ).toEqual(['fullName', 'nickname']);
  });

  it('expands date_wheel into four keys and time_wheel into three', () => {
    expect(allowedKeysForStep({ type: 'date_wheel', storeAs: 'dob' } as QuizStep)).toEqual([
      'dob',
      'dobDay',
      'dobMonth',
      'dobYear',
    ]);
    expect(allowedKeysForStep({ type: 'time_wheel', storeAs: 'wake' } as QuizStep)).toEqual([
      'wake',
      'wakeHour',
      'wakeMinute',
    ]);
  });

  it('returns [] for every presentational type — that empty array IS the classifier', () => {
    for (const type of SCREEN_TYPES) {
      expect(allowedKeysForStep({ type } as QuizStep)).toEqual([]);
      expect(isQuestionStep({ type } as QuizStep)).toBe(false);
    }
  });

  // Guards against the classifier rotting. A new step type added to
  // quiz-schema.ts that nobody classifies would otherwise silently be reported
  // to the CRO dashboard as a passive screen — exactly the confusion the
  // definition catalog exists to remove.
  it('classifies every type in the schema union', () => {
    const declared = quizStepSchema.options.map(
      (option: { shape: { type: { value: string } } }) => option.shape.type.value,
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const type of declared) {
      expect(
        QUESTION_TYPES.has(type) || SCREEN_TYPES.has(type),
        `step type "${type}" is in quiz-schema.ts but not classified in step-answer-keys.test.ts — ` +
          'decide whether it captures answers and update allowedKeysForStep + this test together',
      ).toBe(true);
    }
  });
});
