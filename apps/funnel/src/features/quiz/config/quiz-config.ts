import { quizConfigSchema } from './quiz-schema';

// ─────────────────────────────────────────────────────────────────────────────
// NEUTRAL DEMO QUIZ — replace this file for your product.
// ─────────────────────────────────────────────────────────────────────────────
//
// Eight steps that exercise the engine end to end: a gender capture that powers
// the <g>masc|fem</g> and placeholderByGender personalization, a branching
// question, both arms of that branch, an answer-driven reveal, a form field, the
// lead-capture gate, and the terminal loader that hands off to /offer.
//
// The copy is deliberately obvious placeholder text — every string here is an
// i18n key resolved against packages/i18n/messages/en/quiz.json.
//
// WIRING RULES (violating any of these fails silently at runtime, not at build):
//
//  1. Every `stepId` must appear in STEP_POSITIONS. A missing id defaults to
//     position 1 and the progress header lies.
//  2. Every `nextStepId` / `option.nextStepId` must resolve to a real stepId.
//     useQuizNavigation does `quizStepMap[id] ?? quizConfig.steps[0]`, so a typo
//     teleports the visitor back to step 1 with no error. The config test
//     asserts this.
//  3. Only `loading_screen` and `trial_price` may be terminal — they route
//     through the quiz's completion handler rather than to another step.
//  4. `totalSteps` should equal the highest position on the longest path so the
//     header and progress footer read honestly.
//  5. Every `phase` value must exist under quiz.json's `phases` group, or the
//     header's phase label silently renders empty.
//  6. Do not point an image field at a file that does not exist. The renderers
//     draw a neutral placeholder when an image is omitted; a bad path renders a
//     broken image with no build error.
//
// Branch alternatives SHARE a position: step3 and step3b are the two arms of
// step2's branch, so a visitor traverses one or the other and the progress bar
// does not jump.

const STEP_POSITIONS: Record<string, number> = {
  step1: 1,
  step2: 2,
  step3: 3,
  step3b: 3,
  step4: 4,
  step5: 5,
  step6: 6,
  step7: 7,
};

const config = {
  totalSteps: 7,
  stepPositions: STEP_POSITIONS,
  steps: [
    // ─── Step 1 — Audience split ────────────────────────────────────────────
    // Stored as `gender` because the templating layer keys its <g>masc|fem</g>
    // forms and the input step's placeholderByGender off exactly that name.
    // Rename it only if you also update those two consumers.
    {
      stepId: 'step1',
      phase: 'phases.start',
      type: 'text_select' as const,
      storeAs: 'gender',
      question: 'steps.step1.question',
      subtitle: 'steps.step1.subtitle',
      options: [
        { label: 'steps.step1.options.female.label', value: 'female', icon: '🙋‍♀️', nextStepId: 'step2' },
        { label: 'steps.step1.options.male.label', value: 'male', icon: '🙋‍♂️', nextStepId: 'step2' },
      ],
    },

    // ─── Step 2 — Branching question ────────────────────────────────────────
    // The branch demo: per-option `nextStepId` is how radio / text_select /
    // picture_select / chip_select fork. multi_select, likert, slider and
    // input_group cannot branch — they carry a single step-level nextStepId.
    {
      stepId: 'step2',
      phase: 'phases.start',
      type: 'radio' as const,
      storeAs: 'primaryGoal',
      question: 'steps.step2.question',
      subtitle: 'steps.step2.subtitle',
      options: [
        { label: 'steps.step2.options.a.label', value: 'a', nextStepId: 'step3' },
        { label: 'steps.step2.options.b.label', value: 'b', nextStepId: 'step3' },
        // Third answer takes the short arm and skips the multi-select.
        { label: 'steps.step2.options.c.label', value: 'c', nextStepId: 'step3b' },
      ],
    },

    // ─── Step 3 — Branch arm A: multi-select ────────────────────────────────
    {
      stepId: 'step3',
      phase: 'phases.about',
      type: 'multi_select' as const,
      storeAs: 'challenges',
      question: 'steps.step3.question',
      maxSelection: 3,
      options: [
        { label: 'steps.step3.options.o1.label', value: 'o1' },
        { label: 'steps.step3.options.o2.label', value: 'o2' },
        { label: 'steps.step3.options.o3.label', value: 'o3' },
        { label: 'steps.step3.options.o4.label', value: 'o4' },
      ],
      nextStepId: 'step4',
    },

    // ─── Step 3b — Branch arm B: auto-advancing interstitial ────────────────
    // Shares position 3 with step3. Advances on a timer, so quiz-page wires it
    // through goToStepReplace (see checkpoint_reveal in quiz-schema.ts).
    {
      stepId: 'step3b',
      phase: 'phases.about',
      type: 'checkpoint_reveal' as const,
      title: 'steps.step3b.title',
      subtitle: 'steps.step3b.subtitle',
      nextStepId: 'step4',
    },

    // ─── Step 4 — Answer-driven reveal ──────────────────────────────────────
    // Picks its copy from the `primaryGoal` answer captured in step2. Visitors
    // who somehow arrive without that answer get `fallbackVariant`.
    {
      stepId: 'step4',
      phase: 'phases.about',
      type: 'checkpoint' as const,
      variantBy: 'primaryGoal',
      fallbackVariant: 'a',
      buttonLabel: 'common.continue',
      nextStepId: 'step5',
      variants: {
        a: {
          title: 'steps.step4.a.title',
          subtitle: 'steps.step4.a.subtitle',
          labels: [
            'steps.step4.a.labels.l1',
            'steps.step4.a.labels.l2',
            'steps.step4.a.labels.l3',
          ],
        },
        b: {
          title: 'steps.step4.b.title',
          subtitle: 'steps.step4.b.subtitle',
          labels: [
            'steps.step4.b.labels.l1',
            'steps.step4.b.labels.l2',
            'steps.step4.b.labels.l3',
          ],
        },
        c: {
          title: 'steps.step4.c.title',
          subtitle: 'steps.step4.c.subtitle',
          labels: [
            'steps.step4.c.labels.l1',
            'steps.step4.c.labels.l2',
            'steps.step4.c.labels.l3',
          ],
        },
      },
    },

    // ─── Step 5 — Name capture ──────────────────────────────────────────────
    // `fullName` is in NAME_KEYS, so quiz-page title-cases it on continue.
    // placeholderByGender resolves steps.step5.namePlaceholder.{female|male}.
    {
      stepId: 'step5',
      phase: 'phases.about',
      type: 'input_group' as const,
      question: 'steps.step5.question',
      subtext: 'steps.step5.subtext',
      fields: [
        {
          label: 'steps.step5.nameLabel',
          storeAs: 'fullName',
          inputType: 'text' as const,
          placeholder: 'steps.step5.namePlaceholder',
          placeholderByGender: true,
          autoComplete: 'name',
        },
      ],
      nextStepId: 'step6',
    },

    // ─── Step 6 — Lead-capture gate ─────────────────────────────────────────
    // Submitting fires captureLeadRecord + the hash-email → Meta userData →
    // PostHog identify → GTM chain in quiz-page.handleEmailSubmit.
    {
      stepId: 'step6',
      phase: 'phases.account',
      type: 'email_capture' as const,
      storeAs: 'email',
      buttonLabel: 'steps.step6.button',
      nextStepId: 'step7',
    },

    // ─── Step 7 — Terminal loader ───────────────────────────────────────────
    // onComplete → finalizeAndNavigate('/offer'): fires quiz_completed and does
    // the final answers → sessions.quiz_answers sync before routing. Keep a
    // terminal step of this type (or trial_price) as the last step.
    {
      stepId: 'step7',
      phase: 'phases.account',
      type: 'loading_screen' as const,
      durationMs: 6000,
      brand: 'steps.step7.brand',
      phrases: [
        { title: 'steps.step7.phrases.p1.title', subtitle: 'steps.step7.phrases.p1.subtitle' },
        { title: 'steps.step7.phrases.p2.title', subtitle: 'steps.step7.phrases.p2.subtitle' },
        { title: 'steps.step7.phrases.p3.title', subtitle: 'steps.step7.phrases.p3.subtitle' },
      ],
      nextStepId: 'step7',
    },
  ],
};

export const quizConfig = quizConfigSchema.parse(config);

export const quizStepMap: Record<string, (typeof quizConfig.steps)[number]> =
  Object.fromEntries(quizConfig.steps.map((s) => [s.stepId, s]));

export const FIRST_STEP_ID = quizConfig.steps[0].stepId;

/**
 * Step types that end the quiz instead of navigating to `nextStepId`.
 * The config test uses this to allow their (unused) nextStepId to self-reference.
 */
export const TERMINAL_STEP_TYPES: ReadonlySet<string> = new Set([
  'loading_screen',
  'trial_price',
]);
