import { describe, expect, it } from 'vitest';
import { quizConfig, FIRST_STEP_ID, TERMINAL_STEP_TYPES } from '../../apps/funnel/src/features/quiz/config/quiz-config';
import { QUIZ_VARIANT } from '../../apps/funnel/src/features/quiz/server/quiz-definition';
import messages from '../../packages/i18n/messages/en/quiz.json';
import {
  buildDefinitionSnapshot,
  canonicalize,
  diffStepRows,
  labelKeyForStep,
  stableStringify,
} from '../publish-quiz-definition-lib';

function snapshot(withMessages = true) {
  return buildDefinitionSnapshot(quizConfig as never, {
    quizVariant: QUIZ_VARIANT,
    appKey: 'testapp',
    funnelKey: 'main',
    firstStepId: FIRST_STEP_ID,
    terminalTypes: TERMINAL_STEP_TYPES,
    ...(withMessages ? { messages } : {}),
  });
}

describe('canonicalize / stableStringify', () => {
  it('is independent of object key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('is DEPENDENT on array order — reordering answer options is a real change', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('drops undefined but preserves null', () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('recurses into nested structures', () => {
    expect(canonicalize({ z: [{ b: 1, a: 2 }] })).toEqual({ z: [{ a: 2, b: 1 }] });
  });
});

describe('buildDefinitionSnapshot — shipped boilerplate quiz', () => {
  it('emits one row per configured step, not one per position', () => {
    const built = snapshot();
    // 8 steps but totalSteps 7: step3 and step3b share position 3. Anything
    // keyed on position silently loses an arm.
    expect(built.steps).toHaveLength(quizConfig.steps.length);
    expect(built.total_steps).toBe(quizConfig.totalSteps);
    expect(built.steps.filter((s) => s.position === 3)).toHaveLength(2);
  });

  it('cross-references branch arms that share a position', () => {
    const built = snapshot();
    const step3 = built.steps.find((s) => s.step_id === 'step3');
    const step3b = built.steps.find((s) => s.step_id === 'step3b');
    expect(step3?.shares_position_with).toEqual(['step3b']);
    expect(step3b?.shares_position_with).toEqual(['step3']);
  });

  it('publishes one edge per option for a branching step', () => {
    const built = snapshot();
    const step2 = built.steps.find((s) => s.step_id === 'step2');
    expect(step2?.next).toEqual([
      { to_step_id: 'step3', on_value: 'a' },
      { to_step_id: 'step3', on_value: 'b' },
      { to_step_id: 'step3b', on_value: 'c' },
    ]);
  });

  it('suppresses the terminal self-edge', () => {
    const built = snapshot();
    const step7 = built.steps.find((s) => s.step_id === 'step7');
    // quiz-config gives step7 nextStepId: 'step7' as an unused placeholder.
    // Publishing it would make every terminal step a phantom cycle, and the
    // DB's no-self-edge CHECK rejects it outright.
    expect(step7?.is_terminal).toBe(true);
    expect(step7?.next).toEqual([]);
  });

  it('classifies questions by answer keys, not by step type name', () => {
    const built = snapshot();
    const byId = Object.fromEntries(built.steps.map((s) => [s.step_id, s]));
    expect(byId.step1.is_question).toBe(true);
    expect(byId.step1.answer_keys).toEqual(['gender']);
    expect(byId.step5.answer_keys).toEqual(['fullName']);
    // Presentational steps must read as screens: step_completed fires for them
    // too, so this is the only signal that separates them.
    expect(byId.step3b.is_question).toBe(false);
    expect(byId.step3b.answer_keys).toEqual([]);
    expect(byId.step4.is_question).toBe(false);
    expect(byId.step7.is_question).toBe(false);
  });

  it('marks every shipped step reachable from the first step', () => {
    expect(snapshot().steps.filter((s) => !s.reachable)).toEqual([]);
  });

  it('produces a stable hash across runs', () => {
    expect(snapshot().config_hash).toBe(snapshot().config_hash);
    expect(snapshot().config_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when structure changes but NOT when copy changes', () => {
    const base = snapshot().config_hash;

    // An i18n copy edit — the most common CRO change. Must not force a bump,
    // or someone disables the drift guard within two months.
    const copyEdited = JSON.parse(JSON.stringify(quizConfig));
    copyEdited.steps[0].question = 'steps.step1.question.rewritten';
    copyEdited.steps[0].options[0].label = 'steps.step1.options.female.reworded';
    expect(
      buildDefinitionSnapshot(copyEdited, {
        quizVariant: QUIZ_VARIANT,
        appKey: 'testapp',
        funnelKey: 'main',
        firstStepId: FIRST_STEP_ID,
        terminalTypes: TERMINAL_STEP_TYPES,
      }).config_hash,
    ).toBe(base);

    // Rewiring a branch IS a structural change and must bump.
    const rewired = JSON.parse(JSON.stringify(quizConfig));
    rewired.steps[1].options[0].nextStepId = 'step3b';
    expect(
      buildDefinitionSnapshot(rewired, {
        quizVariant: QUIZ_VARIANT,
        appKey: 'testapp',
        funnelKey: 'main',
        firstStepId: FIRST_STEP_ID,
        terminalTypes: TERMINAL_STEP_TYPES,
      }).config_hash,
    ).not.toBe(base);
  });
});

describe('diffStepRows', () => {
  it('names the exact step and fields that moved', () => {
    const built = snapshot();
    const changed = JSON.parse(JSON.stringify(built.steps));
    changed[2].store_as = 'somethingElse';
    expect(diffStepRows(built.steps, changed)).toEqual([
      { step_id: changed[2].step_id, change: 'changed', fields: ['store_as'] },
    ]);
  });

  it('reports additions and removals', () => {
    const built = snapshot();
    expect(diffStepRows(built.steps.slice(1), built.steps)).toEqual([
      { step_id: built.steps[0].step_id, change: 'added' },
    ]);
    expect(diffStepRows(built.steps, built.steps.slice(1))).toEqual([
      { step_id: built.steps[0].step_id, change: 'removed' },
    ]);
  });
});


describe('step labels', () => {
  it('resolves a readable sentence for every shipped step', () => {
    const built = snapshot();
    for (const step of built.steps) {
      expect(step.label, `step ${step.step_id} has no label`).toBeTruthy();
      // The whole point: a key would be just as useless as the raw step id.
      expect(step.label).not.toMatch(/^steps\./);
    }
  });

  it('reads the key from the right config field per step type', () => {
    const byId = Object.fromEntries(quizConfig.steps.map((s) => [s.stepId, s]));
    // question-bearing types
    expect(labelKeyForStep(byId.step1 as never, messages)).toBe('steps.step1.question');
    // checkpoint_reveal titles its screen
    expect(labelKeyForStep(byId.step3b as never, messages)).toBe('steps.step3b.title');
    // checkpoint takes the fallback variant's title
    expect(labelKeyForStep(byId.step4 as never, messages)).toBe('steps.step4.a.title');
    // email_capture carries no text field in the config at all — probed
    expect(labelKeyForStep(byId.step6 as never, messages)).toBe('steps.step6.title');
  });

  it('leaves the label null rather than guessing when there is no message pack', () => {
    expect(snapshot(false).steps.every((s) => s.label === null)).toBe(true);
  });

  it('keeps labels OUT of the config hash', () => {
    // Copy edits are the most common CRO change. If they forced a quiz_variant
    // bump the drift guard would be switched off within two months.
    expect(snapshot(true).config_hash).toBe(snapshot(false).config_hash);
  });
});

describe('unconditional — the branch-vs-drop signal', () => {
  it('marks only the steps every route passes through', () => {
    const byId = Object.fromEntries(snapshot().steps.map((s) => [s.step_id, s]));
    // step2 branches: option c goes to step3b, a/b go to step3. So NEITHER arm
    // is on every route, while everything before and after the branch is.
    expect(byId.step1.is_unconditional).toBe(true);
    expect(byId.step2.is_unconditional).toBe(true);
    expect(byId.step3.is_unconditional).toBe(false);
    expect(byId.step3b.is_unconditional).toBe(false);
    expect(byId.step4.is_unconditional).toBe(true);
    expect(byId.step7.is_unconditional).toBe(true);
  });

  it('is decided by reachability, not by a shared position', () => {
    const built = snapshot();
    const shared = built.steps.filter((s) => s.position === 3);
    expect(shared).toHaveLength(2);
    // Both arms share position 3 AND are both conditional here — but a shared
    // position proves nothing on its own, which is why step4 (alone at its
    // position, yet downstream of the merge) is unconditional.
    expect(shared.every((s) => !s.is_unconditional)).toBe(true);
    expect(built.steps.find((s) => s.step_id === 'step4')?.position).toBe(4);
  });

  it('has no skip concept in the boilerplate schema', () => {
    expect(snapshot().steps.every((s) => s.entry_skippable === false)).toBe(true);
  });
});

describe('unmodelled routing is refused, not guessed', () => {
  // Found by running this algorithm over carnivore-app's real 47-step quiz and
  // diffing against its independently generated manifest. Three steps
  // disagreed, all because that config routes in ways this file does not model.
  // The guard turns a plausible wrong number into a loud failure.
  it.each(['skipIf', 'branches', 'whenOnly', 'skipNextStepId'])(
    'refuses to publish a step using %s',
    (key) => {
      const broken = JSON.parse(JSON.stringify(quizConfig));
      broken.steps[1][key] = { answerKey: 'x', nextStepId: 'step7' };
      expect(() =>
        buildDefinitionSnapshot(broken, {
          quizVariant: QUIZ_VARIANT,
          appKey: 'testapp',
          funnelKey: 'main',
          firstStepId: FIRST_STEP_ID,
          terminalTypes: TERMINAL_STEP_TYPES,
        }),
      ).toThrow(/does not model/);
    },
  );

  it('does not mistake the step id itself for a route', () => {
    expect(() => snapshot()).not.toThrow();
  });
});
