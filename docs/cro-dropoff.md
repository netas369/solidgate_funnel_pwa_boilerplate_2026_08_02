# Quiz drop-off tracking

A plain-English tour. The detailed specs live in `docs/quiz-backend/` — start here.

## What it does

Tells you which question in the quiz loses people, and doesn't lie to you when the quiz
branches.

Each app has its **own** CRO dashboard, reading its own database directly — the same
shape carnivore-app and glp-app already use. PMC Hub links out to each one rather than
merging them, so every product owns its funnel view and nothing breaks across products.

## What you get

```
Started 2027   Reached the end 183   Finished 9%

BIGGEST LOSS: "To personalise your plan, select your gender"
  1690 people saw this and left without answering — 86%

  #  reached  left here          question
  1     2027  80 (3.9%)          Lose weight with the Carnivore diet…
  2     1964  1690 (86%)         To personalise your plan, select your…  <Most people leave here>
  3      274  17 (6.2%)          How much weight would you like to lose?
 13      213  6 (2.8%)           Which of these have you already tried?
       └ Everyone sees this     5 (2.4%) of 206  Why you're hungry again…
       └ Only some visitors     0 (0%) of 129   Most diets fight hunger…
```

That's real output, from a week of live CarniDiet traffic run through this pipeline.

The indented rows are the point. A quiz branches — some screens everyone sees, some only
appear if you answered a certain way. Counted naively, a screen shown to a third of
visitors looks like a 67% catastrophe. The system knows which is which and says so.

## How it works

**1. The quiz records what happened.** As someone moves through, each question gets a note
on their session row: when they first saw it, whether they answered, whether they skipped
it, how many times they came back. No extra network requests — it rides along on a save the
quiz already makes. It records *that* a question was answered and *when*, never *what* was
answered; answers stay in `sessions.quiz_answers` exactly as before.

**2. A price list decodes it.** That note only stores codes like `step3b`. A small set of
tables — the *catalog* — says what each code means: the question text, where it sits, and
whether everyone sees it or only some people. One catalog per quiz version, so last
month's data still reads correctly after you change the quiz.

**3. The dashboard renders it.** Two calls do the work, and the dashboard draws the result.

## Building the dashboard

It lives inside the app and queries directly with the service-role client. Two calls:

```ts
const { data } = await admin.rpc('cro_step_funnel', {
  p_from, p_to, p_quiz_variant, p_funnel_variant, p_locale,
});
const view = assembleFunnelResponse(data, { /* @repo/shared/cro/funnel-response */ });
```

`cro_step_funnel()` counts; `assembleFunnelResponse()` turns those counts into rows you can
draw — positions in order, branch arms resolved, every percentage and badge worked out.
`cro_funnel_segments()` backs the filter pickers.

**Use those rather than querying `step_activity` yourself.** They carry four things a fresh
query gets wrong without ever announcing it:

- whether a session went on past a step (needs the branch graph)
- the settle window, so someone who started ten minutes ago isn't counted as having quit
- merging a step that comes back once per A/B variant
- which screens everyone sees versus only some people

All four produce a chart that looks completely normal and is simply wrong.

## What you have to do

**When you change the quiz**, bump `QUIZ_VARIANT` in
`apps/funnel/src/features/quiz/server/quiz-definition.ts` and add a line to
`packages/shared/src/cro/segment-labels.ts` describing what changed. That note is what
makes a comparison intelligible six months later — *"v2 vs v3"* tells you nothing,
*"added the intro split"* does.

If you forget to bump it, the next publish **fails loudly** rather than quietly blending
two different question sets under one name.

**When you deploy**, run:

```sh
npx tsx scripts/publish-quiz-definition.ts --apply
```

Leave off `--apply` for a dry run showing exactly what it would write.

## What it deliberately doesn't do

**No "went back" or "hit an error" counts.** Recording those needs a row per event; this
stores a summary per question instead.

**No answer breakdowns, live view, or device split.** Those need data this template doesn't
collect. Each is additive if a product wants it.

**No stored history.** Numbers are computed from live session rows each time. When a
customer exercises their right to deletion, their sessions go, and past figures shift
slightly. That was a deliberate choice over keeping a separate archive.

**No cross-product view.** Comparing funnels across apps means opening each dashboard. That
was chosen over a universal payload every app would have to implement identically.

## If something looks wrong

**Every row says `step3b` instead of a question.** The catalog wasn't published for that
version — run the publish command.

**A step shows zero and you expected traffic.** Genuine: it's shown as a real row rather
than hidden, so a screen nobody reaches is visible instead of silently missing.

**A percentage looks mad on a new funnel.** Under 30 people the view flags it as a small
sample and ranks problems by how many people were lost rather than by percentage. A
confident 33% off three sessions is worse than no number.

## Where the detail lives

| | |
|---|---|
| `docs/quiz-backend/CRO_TRACKING.md` | how recording and the catalog work |
| `docs/quiz-backend/DATA_MODEL.md` | the session and event tables |
