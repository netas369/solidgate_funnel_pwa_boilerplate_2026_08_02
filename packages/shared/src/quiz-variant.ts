/**
 * The two variant constants, in a package both apps can read.
 *
 * They live here rather than in the funnel's quiz module because the CRO
 * dashboard needs them — to default its version filter and to label a chip —
 * and importing `features/quiz/server/quiz-definition` would drag the whole
 * quiz engine (config, schema, answer validation, the branch walker) into a
 * second app. `quiz-definition.ts` re-exports them, so every existing import
 * site is unchanged.
 *
 * ── WHAT THESE MEAN, AND WHY THEY ARE NOT THE SAME KIND OF THING ───────────
 *
 * `QUIZ_VARIANT` is the immutable QUESTION SET. Change the quiz — reword a
 * question, add a step, rename an option code — and this must be bumped.
 * `publish_quiz_definition()` enforces it: publishing a changed config under an
 * unchanged variant raises QUIZ_DEFINITION_DRIFT. Two versions ask different
 * questions and number them differently, so their funnels must never be
 * blended into one curve.
 *
 * `FUNNEL_VARIANT` is the per-visitor PRESENTATION/OFFER A/B bucket, assigned
 * from the visitor id by `assignFunnelVariant()`. Several funnel variants share
 * one question set, so blending them IS correct, and the CRO assembler merges
 * them on purpose.
 *
 * They are orthogonal axes, not parent and child.
 *
 * ── WHEN YOU BUMP QUIZ_VARIANT ─────────────────────────────────────────────
 *
 * Add a matching entry to `cro/segment-labels.ts` describing what changed, and
 * redeploy the CRO app — its default version filter reads this constant, so a
 * stale deploy points the board at a retired version.
 */
export const QUIZ_VARIANT = 'boilerplate-v1';
export const FUNNEL_VARIANT = 'main-v1';
