# Quiz drop-off tracking

A plain-English tour. The detailed specs live in `docs/quiz-backend/` — start here.

## What it does

Tells you which question in the quiz loses people, and doesn't lie to you when the quiz
branches.

It's built to be read by **one internal dashboard that covers several products at once**,
so each app serves its numbers over HTTP rather than letting the dashboard poke around in
its database.

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

That's real output, from a week of live carnivore traffic run through this pipeline.

The indented rows are the point. A quiz branches — some screens everyone sees, some only
appear if you answered a certain way. Counted naively, a screen shown to a third of
visitors looks like a 67% catastrophe. The system knows which is which and says so.

## How it works

**1. The quiz records what happened.** As someone moves through, each question gets a note
on their session row: when they first saw it, whether they answered, whether they skipped
it, how many times they came back. No extra network requests — it rides along on a save the
quiz already makes.

**2. A price list decodes it.** That note only stores codes like `step3b`. A small set of
tables — the *catalog* — says what each code means: the question text, where it sits, and
whether everyone sees it or only some people. One catalog per quiz version, so last
month's data still reads correctly after you change the quiz.

**3. An endpoint serves it ready to draw.** All the arithmetic happens in the app. The
dashboard receives finished numbers, labels and badges, and just renders them. That's
deliberate: working out which screens are branches needs the quiz's own structure, and we
don't want a dashboard reimplementing that for every product.

## What you have to do

**When you change the quiz**, bump `QUIZ_VARIANT` in
`apps/funnel/src/features/quiz/server/quiz-definition.ts` and add a line to
`apps/funnel/src/features/cro/segment-labels.ts` describing what changed. That note is what
makes a comparison intelligible six months later — *"v2 vs v3"* tells you nothing,
*"added the intro split"* does.

If you forget to bump it, the next publish **fails loudly** rather than quietly blending
two different question sets under one name.

**When you deploy**, run:

```sh
npx tsx scripts/publish-quiz-definition.ts --apply
```

Leave off `--apply` for a dry run showing exactly what it would write.

**When you add a second funnel or product**, add its name to `segment-labels.ts`. That's
the only file a new product normally touches.

## Reading it

```sh
curl -H "x-internal-secret: $INTERNAL_API_SECRET" \
  "https://your-app/api/internal/cro/funnel?from=2026-09-04T00:00:00Z&to=2026-09-11T00:00:00Z"
```

Optional `&funnel=`, `&version=`, `&locale=`. Call it from a server, never a browser — the
secret must not ship to visitors.

## What comes back

The response is shaped like the table you're going to draw. Five parts:

```jsonc
{
  "app":         { … which product, and which views it supports },
  "segments":    { … the filter buttons },
  "totals":      { … the three cards across the top },
  "biggestLoss": { … the red callout, or null },
  "steps":       [ … one entry per row ]
}
```

Filled in, trimmed to the interesting bits:

```jsonc
{
  "contract": 1,                       // bump = breaking change; render what you understand
  "app": {
    "key": "carnidiet",
    "label": "CarniDiet",
    "capabilities": ["overview", "dropoff"]   // hide tabs not listed here
  },

  // One list per filter. ONE entry means "don't show a picker".
  // That single rule is what lets one dashboard serve a product with many
  // funnels and one version, and another with one funnel and many versions.
  "segments": {
    "funnels":  [{ "id": "main-v1", "label": "Main funnel", "sessions": 2048 }],
    "versions": [{ "id": "v3", "label": "Version 3",
                   "note": "added the intro split", "sessions": 2048 }],
    "locales":  [{ "id": "en", "label": "English", "sessions": 2048 }],
    "selected": { "funnel": null, "version": "v3", "locale": null }
  },

  "totals": {
    "entered": 2027,        // "Started"
    "finished": 183,        // "Reached the end"
    "finishPct": 9,         // "Finished"
    "smallSample": false    // under 30 people — show a caveat, don't trust the percentages
  },

  "biggestLoss": {
    "label": "To personalise your plan, select your gender",
    "droppedPeople": 1690,
    "dropPct": 86,
    "isLeadOfPosition": true    // false ⇒ it was an extra screen, say which question
  },

  "steps": [ /* see below */ ]
}
```

### One entry per row

Each entry in `steps` is one row of the table. Everything needed to draw it is already
computed — there's no arithmetic left to do:

```jsonc
{
  "displayIndex": 2,          // the number in the left column
  "reached": 1964,            // "1,964 reached"
  "changeFromPrev": -63,      // "-63 since previous"
  "barPct": 96.9,             // how wide to draw the bar
  "dropBarPct": 86,           // how much of it is red
  "severity": "heavy",        // heavy | notable | normal
  "severityLabel": "Most people leave here",   // the badge, or null
  "hasTraffic": true,         // false = published but nobody reached it

  "lead": {                   // the question itself
    "stepId": "step1b",
    "label": "To personalise your plan, select your gender",
    "kind": "question",       // "screen" = informational, nobody answers it
    "viewed": 1964, "answered": 273,
    "dropped": 1690, "dropPct": 86,
    "p50Ms": 3200, "p90Ms": 14000
  },

  "companions": [],           // extra screens EVERYONE sees — real drop
  "branches": [],             // extra screens only SOME see — different denominator
  "armAlertPct": null         // a hidden branch is losing badly; show the warning
}
```

### The part that matters

`companions` and `branches` are why this exists. Both are extra screens sitting at the
same question number, and they must be read differently:

```
 13      213  6 (2.8%)          Which of these have you already tried?
       └ Everyone sees this     5 (2.4%) of 206   ← companion: a real 2.4% loss
       └ Only some visitors     0 (0%) of 129     ← branch: 129 of 213 were sent here,
                                                     the other 84 weren't — not a loss
```

Each arm carries a `tag` with that exact wording and a `shareOfSlotPct` — its share of
**this question's** traffic, never of everyone who started. A screen shown to a third of
visitors would otherwise read as a 67% cliff.

Steps that are no longer in the quiz come back with `retired: true` and no position, so old
data still shows up without being mixed into the curve.

Field-by-field detail, including everything trimmed here:
`docs/quiz-backend/CRO_DASHBOARD_CONTRACT.md`.

## What it deliberately doesn't do

**No "went back" or "hit an error" counts.** Two cells in the detail panel stay empty.
Recording those needs a row per event; this stores a summary per question instead.

**Only the drop-off view.** The dashboard's other tabs — answer breakdowns, who's on the
quiz right now, language and device — need data this template doesn't collect. The
response says which views it supports, so the dashboard hides the rest rather than showing
empty screens.

**No stored history.** Numbers are computed from live session rows each time. When a
customer exercises their right to deletion, their sessions go, and past figures shift
slightly. That was a deliberate choice over keeping a separate archive.

## If something looks wrong

**Every row says `step3b` instead of a question.** The catalog wasn't published for that
version — run the publish command.

**A step shows zero and you expected traffic.** Genuine: it's shown as a real row rather
than hidden, so a screen nobody reaches is visible instead of silently missing.

**A percentage looks mad on a new funnel.** Under 30 people the response flags it as a
small sample, and ranks problems by how many people were lost rather than by percentage.
A confident 33% off three sessions is worse than no number.

## Where the detail lives

| | |
|---|---|
| `docs/quiz-backend/CRO_TRACKING.md` | how recording and the catalog work |
| `docs/quiz-backend/CRO_DASHBOARD_CONTRACT.md` | the exact response, field by field |
| `docs/quiz-backend/DATA_MODEL.md` | the session and event tables |

**Changing any of this?** `CRO_DASHBOARD_CONTRACT.md` opens with a rule: the spec is the
source of truth, and any deviation gets reported and agreed before it's built. Several
products read the same contract, so a change that looks local isn't.
