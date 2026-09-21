import { z } from 'zod';

// Step-type vocabulary for the quiz engine.
//
// Every member of the discriminated union below has exactly one renderer in
// `components/steps/` and one `case` in quiz-page.tsx's renderStep(). Adding a
// step type means touching those three places and nothing else.
//
// All `label` / `question` / `title` style fields hold i18n KEYS resolved at
// render time against the `quiz` namespace (packages/i18n/messages/en/quiz.json),
// not literal copy. The two documented exceptions are `expertName` (personal
// names are not localized) and emoji `icon` values.
//
// All `image` fields are OPTIONAL. The boilerplate ships no raster art, and the
// renderers fall back to a neutral CSS placeholder, so a demo config stays
// visually coherent before any assets exist. Point them at real files once you
// have them.

// ─── Option Schemas ────────────────────────────────────────────────────────────

const radioOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  nextStepId: z.string(),
  subtitle: z.string().optional(),
  icon: z.string().optional(),
  image: z.string().optional(),
});

const multiSelectOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  subtitle: z.string().optional(),
  icon: z.string().optional(),
});

const inputFieldSchema = z.object({
  label: z.string(),
  storeAs: z.string(),
  unit: z.string().optional(),
  inputType: z.enum(['text', 'date', 'time', 'email']).optional(),
  optional: z.boolean().optional(),
  autoComplete: z.string().optional(),
  placeholder: z.string().optional(),
  // When set, `placeholder` addresses a group of keys rather than one string,
  // and the view appends `.female` / `.male` based on the stored `gender`
  // answer (used so the example value matches the visitor).
  placeholderByGender: z.boolean().optional(),
});

// ─── Step Schemas ──────────────────────────────────────────────────────────────

const baseStep = z.object({
  stepId: z.string(),
  // i18n key under the `phases` group; rendered as the header's phase label.
  phase: z.string(),
});

// Single-select list of text rows. Each option carries its own `nextStepId`,
// which is how the engine branches. Auto-advances shortly after a tap.
const radioStepSchema = baseStep.extend({
  type: z.literal('radio'),
  storeAs: z.string(),
  question: z.string(),
  tagline: z.string().optional(),
  subtitle: z.string().optional(),
  options: z.array(radioOptionSchema).min(2),
});

// Multi-select with an optional cap, confirmed with a Continue button. Branches
// at the step level (one `nextStepId`) because there is no single answer to
// branch on.
const multiSelectStepSchema = baseStep.extend({
  type: z.literal('multi_select'),
  storeAs: z.string(),
  question: z.string(),
  maxSelection: z.number().optional(),
  options: z.array(multiSelectOptionSchema).min(2),
  nextStepId: z.string(),
});

// Free-form form step: one or more text/date/time/email fields, each writing to
// its own `storeAs` key. date/time fields open the shared wheel pickers.
const inputGroupStepSchema = baseStep.extend({
  type: z.literal('input_group'),
  question: z.string(),
  subtext: z.string().optional(),
  fields: z.array(inputFieldSchema).min(1),
  nextStepId: z.string(),
});

const loadingPhraseSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
});

// Terminal step: a full-bleed timed loader that cycles `phrases` and then calls
// the quiz's completion handler (fires quiz_completed, syncs answers, routes to
// the offer). `nextStepId` is kept for schema symmetry but is not navigated to.
const loadingScreenStepSchema = baseStep.extend({
  type: z.literal('loading_screen'),
  durationMs: z.number(),
  loadingSteps: z.array(z.string()).min(1).optional(),
  phrases: z.array(loadingPhraseSchema).min(1).optional(),
  // Wordmark shown inside the loader. i18n key or literal.
  brand: z.string().optional(),
  nextStepId: z.string(),
});

// The lead-capture gate: email + GDPR processing consent. Submitting commits
// the complete answer save + lead event before analytics identification (see quiz-page).
const emailCaptureStepSchema = baseStep.extend({
  type: z.literal('email_capture'),
  storeAs: z.string(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Expert note step (credibility interstitial) ────────────────────────────
// A portrait of a reviewing expert above a claim about how the programme was
// built. `expertName` is a literal, not a translation key — personal names are
// not localized.
const expertNoteStepSchema = baseStep.extend({
  type: z.literal('expert_note'),
  // Hero illustration; the expert card overlaps its bottom edge.
  heroImage: z.string().optional(),
  // Expert portrait, rendered as a small avatar inside that card.
  image: z.string().optional(),
  badgeLabel: z.string(),
  expertName: z.string(),
  expertTitle: z.string(),
  title: z.string(),
  body: z.string(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Social wall step (community proof) ─────────────────────────────────────
// Rows of short reaction chips drifting horizontally behind a headline. The
// chips carry no attribution beyond an avatar, so they read as ambient
// community noise rather than as quotable testimonials.
const socialWallChipSchema = z.object({
  label: z.string(),
  image: z.string().optional(),
});

const socialWallStepSchema = baseStep.extend({
  type: z.literal('social_wall'),
  chips: z.array(socialWallChipSchema).min(6),
  title: z.string(),
  subtitle: z.string(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Picture select step (image-grid question) ──────────────────────────────
// A single-select question rendered as a 2-column grid of image cards (each an
// illustration with a gradient overlay + label). Auto-advances on tap. Options
// carry their own nextStepId, so this type can branch.
const pictureOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  image: z.string().optional(),
  nextStepId: z.string(),
});

const pictureSelectStepSchema = baseStep.extend({
  type: z.literal('picture_select'),
  storeAs: z.string(),
  question: z.string(),
  options: z.array(pictureOptionSchema).min(2),
});

// ─── Text select step (text-answer list question) ───────────────────────────
// Single-select vertical list of text answer rows, a title + optional subtitle,
// and the progress footer. Auto-advances on tap; branches per option.
const textOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
  nextStepId: z.string(),
  // Optional leading emoji (literal, not an i18n key).
  icon: z.string().optional(),
});

const textSelectStepSchema = baseStep.extend({
  type: z.literal('text_select'),
  storeAs: z.string(),
  question: z.string(),
  subtitle: z.string().optional(),
  options: z.array(textOptionSchema).min(2),
});

// ─── Chip select step (single-select chip cloud) ────────────────────────────
// A single-select question rendered as a centered, wrapping cloud of compact
// emoji chips (content-sized pills, not full-width rows). Auto-advances on tap.
const chipSelectStepSchema = baseStep.extend({
  type: z.literal('chip_select'),
  storeAs: z.string(),
  question: z.string(),
  subtitle: z.string().optional(),
  options: z.array(textOptionSchema).min(2),
});

// ─── Checkpoint step (personalized reveal keyed by a prior answer) ──────────
// A full-bleed reveal: title + subtitle + a central illustration ringed by
// floating "theme" label pills, then a Continue button + progress footer. The
// variant shown is chosen by the answer stored under `variantBy`, falling back
// to `fallbackVariant` when the visitor skipped or branched around that step.
const checkpointVariantSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  labels: z.array(z.string()).min(1),
});

const checkpointStepSchema = baseStep.extend({
  type: z.literal('checkpoint'),
  variantBy: z.string(),
  image: z.string().optional(),
  variants: z.record(z.string(), checkpointVariantSchema),
  fallbackVariant: z.string(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Date wheel step (date picker) ──────────────────────────────────────────
// An iOS-style 3-column scroll wheel (Month / Day / Year) with a highlighted
// centre slot. Emits the chosen date as ISO under `storeAs`, plus derived
// `${storeAs}Day` / `${storeAs}Month` / `${storeAs}Year` keys. Month names are
// localized at runtime; the column placeholder labels come from
// `ui.datePicker.*`. `decorIcons` is an optional row of decorative image tiles
// shown above the wheel.
const dateWheelStepSchema = baseStep.extend({
  type: z.literal('date_wheel'),
  storeAs: z.string(),
  question: z.string(),
  subtitle: z.string().optional(),
  decorIcons: z.array(z.string()).optional(),
  minYear: z.number().optional(),
  maxYear: z.number().optional(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Time wheel step (time picker) ──────────────────────────────────────────
// A 2-column scroll wheel (Hour / Minutes) reusing the shared WheelColumn.
// Emits HH:MM under `storeAs` plus derived `${storeAs}Hour` / `${storeAs}Minute`
// keys. Placeholder labels come from `ui.timePicker.*`.
const timeWheelStepSchema = baseStep.extend({
  type: z.literal('time_wheel'),
  storeAs: z.string(),
  question: z.string(),
  subtitle: z.string().optional(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Analysis loader step (timed loader + interstitial yes/no questions) ────
// A timed answer-summary loader: a rotating mark + cycling phrases, interrupted
// at set progress points by yes/no question pop-ups. Answering resumes the
// loader; it auto-advances once complete.
//
// This is a deliberate engagement device: the pauses turn dead loading time
// into extra answers, and the loader visibly resumes so the wait never feels
// longer for having answered.
const analysisQuestionSchema = z.object({
  // Progress percent (1–99) at which this pop-up interrupts the loader.
  triggerAt: z.number().min(1).max(99),
  question: z.string(),
  // Optional answer key — stores 'yes' | 'no' under this name.
  storeAs: z.string().optional(),
  yesLabel: z.string(),
  noLabel: z.string(),
});

const analysisLoaderStepSchema = baseStep.extend({
  type: z.literal('analysis_loader'),
  // Optional decorative mark that slowly rotates behind the phrases.
  image: z.string().optional(),
  phrases: z.array(z.string()).min(1),
  durationMs: z.number(),
  questions: z.array(analysisQuestionSchema).min(1),
  nextStepId: z.string(),
});

// ─── Trial price step (pay-what-you-want paywall) ───────────────────────────
// "Choose your trial price": N tiers pulled from the shared PRICE_MAP
// (trial1..trial4) for the current locale, formatted with the locale currency.
// The visitor picks a tier; the choice is stored under `storeAs` and the CTA
// completes the quiz. Copy interpolates {price} with the highest tier (the
// "actual cost"). Terminal: `nextStepId` is not navigated to.
const trialPriceStepSchema = baseStep.extend({
  type: z.literal('trial_price'),
  title: z.string(),
  eyebrow: z.string(),
  // Rich string with an <accent>…</accent> span.
  intro: z.string(),
  cardEyebrow: z.string(),
  // Interpolates {price} (the highest/"actual cost" tier).
  cardBody: z.string(),
  note: z.string(),
  buttonLabel: z.string(),
  // PRICE_MAP product ids, left→right (e.g. trial1..trial4).
  tiers: z.array(z.string()).min(2),
  defaultTier: z.string(),
  storeAs: z.string(),
  nextStepId: z.string(),
});

// ─── Checkpoint reveal step (simple reassurance/message screen) ─────────────
// A minimal auto-advancing interstitial: centered title + subtitle + one
// circular illustration with an optional slowly-rotating overlay ring, then the
// progress footer. No answer captured.
//
// IMPORTANT: this step advances on a timer, so quiz-page wires its onContinue
// to goToStepReplace — otherwise browser-Back from the next step lands here and
// immediately bounces forward again. Any new auto-advancing type needs the same
// wiring (see _auto-advance.tsx).
const checkpointRevealStepSchema = baseStep.extend({
  type: z.literal('checkpoint_reveal'),
  title: z.string(),
  subtitle: z.string(),
  image: z.string().optional(),
  overlayImage: z.string().optional(),
  nextStepId: z.string(),
});

// ─── Likert step (agree/disagree statement scale) ──────────────────────────
// A single statement rated on a 5-point emoji scale. End points render larger
// (`strong`), inner points smaller (`soft`). Picking a point stores the value
// and advances — there is no Continue button.
const likertPointSchema = z.object({
  value: z.string(),
  icon: z.string(),
  emphasis: z.enum(['strong', 'soft']).optional(),
});

const likertStepSchema = baseStep.extend({
  type: z.literal('likert'),
  storeAs: z.string(),
  question: z.string(),
  statement: z.string(),
  points: z.array(likertPointSchema).min(2),
  minLabel: z.string(),
  maxLabel: z.string(),
  nextStepId: z.string(),
});

// ─── Slider step (discrete feeling slider) ──────────────────────────────────
// A question answered on a discrete slider; the illustration + centre label
// morph as the slider moves. The track carries no end labels — the morphing
// centre label is the only readout.
const sliderStateSchema = z.object({
  value: z.string(),
  label: z.string(),
  image: z.string().optional(),
});

const sliderStepSchema = baseStep.extend({
  type: z.literal('slider'),
  storeAs: z.string(),
  question: z.string(),
  states: z.array(sliderStateSchema).min(2),
  defaultIndex: z.number().optional(),
  buttonLabel: z.string(),
  nextStepId: z.string(),
});

export const quizStepSchema = z.discriminatedUnion('type', [
  radioStepSchema,
  multiSelectStepSchema,
  inputGroupStepSchema,
  loadingScreenStepSchema,
  emailCaptureStepSchema,
  pictureSelectStepSchema,
  textSelectStepSchema,
  chipSelectStepSchema,
  checkpointStepSchema,
  likertStepSchema,
  sliderStepSchema,
  dateWheelStepSchema,
  timeWheelStepSchema,
  checkpointRevealStepSchema,
  analysisLoaderStepSchema,
  trialPriceStepSchema,
  expertNoteStepSchema,
  socialWallStepSchema,
]);

export const quizConfigSchema = z.object({
  steps: z.array(quizStepSchema).min(1),
  stepPositions: z.record(z.string(), z.number()),
  totalSteps: z.number(),
});

// ─── Exported Types ────────────────────────────────────────────────────────────

export type RadioOption = z.infer<typeof radioOptionSchema>;
export type MultiSelectOption = z.infer<typeof multiSelectOptionSchema>;
export type InputField = z.infer<typeof inputFieldSchema>;

export type RadioStep = z.infer<typeof radioStepSchema>;
export type MultiSelectStep = z.infer<typeof multiSelectStepSchema>;
export type InputGroupStep = z.infer<typeof inputGroupStepSchema>;
export type LoadingScreenStep = z.infer<typeof loadingScreenStepSchema>;
export type EmailCaptureStep = z.infer<typeof emailCaptureStepSchema>;
export type PictureSelectStep = z.infer<typeof pictureSelectStepSchema>;
export type PictureOption = z.infer<typeof pictureOptionSchema>;
export type TextSelectStep = z.infer<typeof textSelectStepSchema>;
export type TextOption = z.infer<typeof textOptionSchema>;
export type ChipSelectStep = z.infer<typeof chipSelectStepSchema>;
export type CheckpointStep = z.infer<typeof checkpointStepSchema>;
export type CheckpointVariant = z.infer<typeof checkpointVariantSchema>;
export type LikertStep = z.infer<typeof likertStepSchema>;
export type LikertPoint = z.infer<typeof likertPointSchema>;
export type DateWheelStep = z.infer<typeof dateWheelStepSchema>;
export type TimeWheelStep = z.infer<typeof timeWheelStepSchema>;
export type CheckpointRevealStep = z.infer<typeof checkpointRevealStepSchema>;
export type AnalysisLoaderStep = z.infer<typeof analysisLoaderStepSchema>;
export type AnalysisQuestion = z.infer<typeof analysisQuestionSchema>;
export type TrialPriceStep = z.infer<typeof trialPriceStepSchema>;
export type ExpertNoteStep = z.infer<typeof expertNoteStepSchema>;
export type SocialWallStep = z.infer<typeof socialWallStepSchema>;
export type SliderStep = z.infer<typeof sliderStepSchema>;
export type SliderState = z.infer<typeof sliderStateSchema>;
export type QuizStep = z.infer<typeof quizStepSchema>;
export type QuizConfig = z.infer<typeof quizConfigSchema>;
