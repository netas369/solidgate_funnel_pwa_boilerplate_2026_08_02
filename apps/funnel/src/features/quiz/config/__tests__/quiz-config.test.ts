import { describe, it, expect } from 'vitest';
import {
  quizConfig,
  quizStepMap,
  FIRST_STEP_ID,
  TERMINAL_STEP_TYPES,
} from '@/features/quiz/config/quiz-config';
import { quizConfigSchema } from '@/features/quiz/config/quiz-schema';

// Structural invariants of whatever quiz config the product ships. These are
// deliberately content-free: replace quiz-config.ts wholesale and this suite
// should still pass unchanged.

describe('quizConfig', () => {
  it('parses against the schema with at least one step', () => {
    expect(quizConfig.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('FIRST_STEP_ID is the first configured step', () => {
    expect(FIRST_STEP_ID).toBe(quizConfig.steps[0].stepId);
  });

  it('every step has a stepId, phase, and type', () => {
    for (const step of quizConfig.steps) {
      expect(typeof step.stepId).toBe('string');
      expect(typeof step.phase).toBe('string');
      expect(typeof step.type).toBe('string');
    }
  });

  it('stepIds are unique', () => {
    const ids = quizConfig.steps.map((s) => s.stepId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stepPositions map covers all stepIds', () => {
    for (const step of quizConfig.steps) {
      expect(quizConfig.stepPositions[step.stepId]).toBeGreaterThan(0);
    }
  });

  it('stepPositions has no entry for a step that does not exist', () => {
    const ids = new Set(quizConfig.steps.map((s) => s.stepId));
    for (const id of Object.keys(quizConfig.stepPositions)) {
      expect(ids.has(id), `stepPositions has a stale entry "${id}"`).toBe(true);
    }
  });

  it('totalSteps matches the highest configured position', () => {
    const highest = Math.max(...Object.values(quizConfig.stepPositions));
    expect(quizConfig.totalSteps).toBe(highest);
  });

  it('quizStepMap provides O(1) lookup for all steps', () => {
    for (const step of quizConfig.steps) {
      expect(quizStepMap[step.stepId]).toBeDefined();
      expect(quizStepMap[step.stepId].stepId).toBe(step.stepId);
    }
  });

  // useQuizNavigation resolves a destination with
  // `quizStepMap[id] ?? quizConfig.steps[0]`, so a typo'd nextStepId silently
  // teleports the visitor back to step 1 with no error anywhere. This is the
  // guard against that.
  it('every nextStepId and option.nextStepId resolves to a real step', () => {
    for (const step of quizConfig.steps) {
      if ('nextStepId' in step && typeof step.nextStepId === 'string') {
        expect(
          quizStepMap[step.nextStepId],
          `${step.stepId}.nextStepId → "${step.nextStepId}" does not exist`,
        ).toBeDefined();
      }
      if ('options' in step && Array.isArray(step.options)) {
        for (const option of step.options) {
          if ('nextStepId' in option && typeof option.nextStepId === 'string') {
            expect(
              quizStepMap[option.nextStepId],
              `${step.stepId} option "${option.value}" → "${option.nextStepId}" does not exist`,
            ).toBeDefined();
          }
        }
      }
    }
  });

  // Reaching the offer is the whole point of the quiz. Exactly one of the
  // terminal types must be present, or the visitor walks off the end of the
  // config and nothing completes the session.
  it('has at least one terminal step so the quiz can reach the offer', () => {
    const terminals = quizConfig.steps.filter((s) => TERMINAL_STEP_TYPES.has(s.type));
    expect(terminals.length).toBeGreaterThanOrEqual(1);
  });

  it('the last configured step is terminal', () => {
    const last = quizConfig.steps[quizConfig.steps.length - 1];
    expect(TERMINAL_STEP_TYPES.has(last.type)).toBe(true);
  });

  // Every image the config declares must be a path the app can actually serve.
  // next/image renders these unoptimized, so a bad path is a broken image with
  // no build-time error.
  it('declares no image paths (the boilerplate ships no raster art)', () => {
    const found: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === 'string') {
        if (/\.(webp|png|jpe?g|gif|avif|svg)(\?|$)/i.test(node)) found.push(node);
        return;
      }
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(quizConfig.steps);
    expect(found).toEqual([]);
  });
});

describe('quizConfigSchema validation', () => {
  it('throws for config with empty steps array', () => {
    expect(() =>
      quizConfigSchema.parse({
        steps: [],
        stepPositions: {},
        totalSteps: 0,
      })
    ).toThrow();
  });

  it('throws for step with unknown type', () => {
    expect(() =>
      quizConfigSchema.parse({
        steps: [
          {
            stepId: 'test',
            phase: 'Phase 1',
            type: 'unknown_type',
          },
        ],
        stepPositions: { test: 1 },
        totalSteps: 1,
      })
    ).toThrow();
  });

  it('throws for radio step missing options', () => {
    expect(() =>
      quizConfigSchema.parse({
        steps: [
          {
            stepId: 'test',
            phase: 'Phase 1',
            type: 'radio',
            storeAs: 'goal',
            question: 'Q?',
            options: [{ label: 'Only one', value: 'one', nextStepId: 'next' }],
          },
        ],
        stepPositions: { test: 1 },
        totalSteps: 1,
      })
    ).toThrow();
  });
});
