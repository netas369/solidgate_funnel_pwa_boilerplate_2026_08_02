# CRO Dashboard Contract

> ## ⚠️ Deviation protocol — read this first
>
> **This document is the specification. The code implements it. If they disagree, this
> document is right and the code is a bug.**
>
> If you are an AI agent (or anyone) working on this feature and you find that something
> here cannot be implemented as written, is wrong, or would be better done differently:
>
> 1. **STOP. Do not implement the deviation.**
> 2. **Report it to the user**: what this document says, what you would do instead, and
>    why — the concrete reason, not a preference.
> 3. **Wait for an explicit instruction to proceed.**
> 4. Only after the user agrees, implement it **and update this document in the same
>    change**, so the spec never silently drifts from the code.
>
> This rule exists because the dashboard reads many apps built from this template. A
> deviation that looks local is a contract change for every product at once, and a
> dashboard cannot detect that a number now means something different — it just renders
> the wrong answer confidently.
>
> Silent deviation is the failure mode this protocol prevents. A reported deviation that
> turns out to be a good idea costs one message; an unreported one costs a wrong decision
> made from a chart nobody doubted.

The HTTP shape every app built from this template serves to the **internal CRO dashboard**.

> Looking for the plain-English version? [`docs/cro-dropoff.md`](../cro-dropoff.md).

The dashboard is external to every product. It cannot query any app's Supabase (the CRO
tables are `service_role`-only with RLS on and zero policies), and it must not hold N
service-role keys. So each app exposes a small read-only HTTP surface behind
`INTERNAL_API_SECRET`, and **returns display-ready data**: the dashboard renders, it does
not interpret.

> **Design rule.** If a number appears on screen, the app computed it. The dashboard's only
> jobs are fanning out to N apps, laying results out, and formatting. Any arithmetic in the
> dashboard is a bug in this contract.

## Why the app side computes

Not tidiness — correctness. Turning branch arms into one honest row requires the quiz
graph: which steps share a position, which are reachable by every route, which successor
edges count as advancing. A dashboard doing that has to reimplement reachability against
N different quizzes and be right about all of them, silently, forever. That logic already
exists per app. It stays there.

## The two segmentation axes

The existing dashboards each grew one axis and not the other:

| App | Funnels | Versions |
|---|---|---|
| `carnivore-app` | one (implicit) | `quiz_version` v1/v2/v3, picker + `cro_quiz_versions` |
| `glp-app` | `funnel_angle` diet-first / on-medication, picker + `cro_funnel_angles` | none |
| this template | `funnel_key` | `quiz_variant` |

They are genuinely different things and both are needed:

- a **funnel** is a distinct acquisition angle — its own quiz, its own offer, its own
  landing page. Two funnels ask different questions, so their position 5 is not the same
  question and their curves must never be blended into one line.
- a **version** is an iteration of *one* funnel — same intent, changed questions or
  wording. Versions renumber, so blending them is equally wrong.

**Every app reports both, always.** An app with one funnel returns a one-element
`funnels` list; an app with one version returns a one-element `versions` list. The
dashboard then has exactly one rule — *render a picker when a list has more than one
entry* — and never needs to know which products have which axis. That is the whole
unification.

**Version is never blended.** It always resolves to a concrete value, defaulting to the
deployed `QUIZ_VARIANT`. Two versions ask different questions and renumber, so combining
them into one curve would be meaningless.

**Funnel variants ARE combined when no filter is given, and that is correct here.** In this
template a funnel variant is a presentation/offer A/B bucket that shares one
`quiz_variant` — same questions, same positions — so summing them is honest.

That summing is load-bearing rather than incidental: `cro_step_funnel` groups by
`(quiz_variant, funnel_variant, step_id)`, so an app running an A/B returns each step once
per variant. The assembler merges rows by `step_id` BEFORE bucketing them by position.
Skipping that merge files the second copy as an extra screen at the same position, and a
step appears as its own companion with wrong numbers. glp-app's `funnel-view.ts` merges the
same way.

A product that maps funnel variants onto genuinely different quizzes must not rely on this:
it would need to filter by funnel, or the contract needs a blended-axis warning it does not
currently have.

## Where the picker names come from

The database only ever knows ids — `main-v1`, `boilerplate-v1`, `en`. Rendered raw, a
version picker reads `[ boilerplate-v1 ]`, which is clickable but says nothing about what
changed between two versions.

**The app supplies the names, not the dashboard.** `apps/funnel/src/features/cro/segment-labels.ts`
holds two small registries — one for funnels, one for quiz versions — and the endpoint
attaches `label` (and `note`, for versions) to every segment option. A new product edits
that one file; everything else in the CRO pipeline is generated from the quiz config.

Three rules there:

- **Not stored in the catalog.** `quiz_definitions` is immutable so that step labels keep
  describing the questions exactly as they were asked. A picker caption is not data
  meaning, and freezing it would mean a typo could only be fixed by bumping `QUIZ_VARIANT`
  and republishing. Resolved at request time instead, so correcting one is a deploy.
- **Keep retired versions listed.** Sessions under an old `quiz_variant` still appear in
  historical windows. Dropping an entry is not an error — the id is shown — it just makes
  an old window harder to read.
- **Locales need no registry.** `Intl.DisplayNames` already knows every language; a
  hand-kept list of 15 would only drift.

The `note` field is the one that earns its place: *"v2 vs v3"* means nothing three months
later, whereas *"added the intro split"* does.

## Capabilities — apps are not equally capable

The forked dashboards render five tabs. This template cannot fill three of them today:

| Tab | Needs | Template | carnivore / glp |
|---|---|---|---|
| Overview | per-step counts | ✅ | ✅ |
| Drop-off | per-step counts + graph | ✅ | ✅ |
| Answers | recorded answer values | ❌ | ✅ (`quiz_step_events.answer`) |
| Right now | live dwell per session | ❌ | ✅ (`cro_live_sessions`) |
| Language & device | `device` per event | ❌ | ✅ (`cro_segment_breakdown`) |

So the payload declares what it supports and the dashboard hides the rest. Without this,
the dashboard either guesses per product or renders empty tabs:

```json
"capabilities": ["overview", "dropoff"]
```

This is also the honest migration path: a product gains a tab by collecting the data and
adding the capability, with no dashboard change.

## Endpoint

```
GET /api/internal/cro/funnel
      ?from=<iso>&to=<iso>
      [&funnel=<id>][&version=<id>][&locale=<id>]

x-internal-secret: <this app's INTERNAL_API_SECRET>
```

`from`/`to` required, half-open `[from, to)`. Omitting an axis blends it. Server-side
only — these routes set no CORS headers, so a browser call fails rather than leaking the
secret.

## Response

```jsonc
{
  "contract": 1,

  "app": {
    "key": "carnidiet",                    // quiz_definitions.app_key
    "label": "CarniDiet",
    "generatedAt": "2026-09-11T09:00:00Z",
    "capabilities": ["overview", "dropoff"]
  },

  // Every axis, always. One entry means "no picker".
  //
  // `label` and `note` come from the APP, not the dashboard — see
  // features/cro/segment-labels.ts. The dashboard holds no per-product naming,
  // and an unregistered id falls back to itself rather than an empty button.
  "segments": {
    "funnels":  [{ "id": "main-v1", "label": "Main funnel", "sessions": 1200 }],
    "versions": [{ "id": "v3", "label": "Version 3", "note": "added the intro split",
                   "sessions": 900, "firstSeen": "…", "lastSeen": "…" }],
    "locales":  [{ "id": "en", "label": "English", "sessions": 800 }],
    "selected": { "funnel": "main-v1", "version": "v3", "locale": null }
  },

  "range": { "from": "…", "to": "…" },

  "totals": {
    "entered": 1180,           // reached the first live position
    "finished": 300,           // reached the terminal position
    "finishPct": 25.4,
    "smallSample": false       // entered < 30 — dashboard shows the caveat, never guesses
  },

  // One entry per POSITION, ordered, arms already resolved.
  "steps": [
    {
      "position": 13,
      "displayIndex": 12,      // 1-based rendered ordinal; positions are not contiguous
      "positionPct": 39.4,     // position ÷ totalSteps, for cross-app curve overlay
      "reached": 812,
      "changeFromPrev": -45,
      "retired": false,        // in the data, no longer in the quiz
      "severity": "heavy",     // heavy >= 25% | notable >= 10% | normal

      "lead": {
        "stepId": "step12",
        "label": "What is your biggest challenge?",
        "kind": "question",    // question | screen
        "viewed": 812, "answered": 640, "skipped": 0,
        "dropped": 172, "dropPct": 21.2, "completionPct": 78.8,
        "p50Ms": 4500, "p90Ms": 19000
      },

      // Share the position AND every route passes through them: real drop.
      "companions": [],
      // Only some visitors are routed here: drop is against their own `viewed`.
      "branches": [ { "stepId": "step12b", "shareOfSlotPct": 33.5, "...": "same shape" } ],
      "worstArmDropPct": 31.2
    }
  ],

  // The single "Biggest loss" card on the drop-off page. Null when nothing is
  // worse than "normal", which is exactly when the card is not rendered.
  // A top-5 list belongs to the Overview tab and is not built.
  "biggestLoss": {
    "stepId": "step12b", "label": "How often do you cook at home?",
    "droppedPeople": 412, "dropPct": 31.2,
    "isLeadOfPosition": false, "displayIndex": 12
  },

  "warnings": [
    { "code": "SMALL_SAMPLE", "message": "Only 18 people entered — percentages are not meaningful yet." }
  ]
}
```

Everything the forked dashboards compute in `funnel-view.ts`, `presentation.ts` and the
page components — `completionPct`, `dropPct`, `reached`, `changeFromPrev`,
`worstArmDropPct`, `displayIndex`, `severity`, `rankByLoss`, `isSmallSample` — is
pre-computed here. The step **label** is resolved here too, so the dashboard needs no
per-app manifest.

### Fields an app cannot fill

Emit `null`, never `0`. A zero is a measurement; a null is an absence, and the dashboard
must render them differently. The template returns real numbers for every field it ships;
fields it cannot measure are absent from the contract rather than present and empty.

## Lead / companions / branches — keep the three-way split

Both existing dashboards get this right and it must survive:

- **lead** — the first screen at a position by declared order.
- **companions** — share the position and *every* route passes through them. Their drop is
  real and is rendered at full weight.
- **branches** — only some visitors are routed there. Their drop is measured against their
  own `viewed`, and `shareOfSlotPct` is share *of the slot*, never of funnel entry.

`unconditional` must be computed by **reachability with the step removed**, exactly as
`scripts/quiz-step-graph-build.ts` does in both products:

```ts
const without = reachable(edges, firstStepId, stepId);
const unconditional = stepId === firstStepId || liveTerminals.every((id) => !without.has(id));
```

Inferring it from a repeated `position` is wrong in both directions — the older admin board
in each repo does exactly that, and both repos' docs call it out as a mistake.

**The publisher computes this and stores it as `quiz_definition_steps.is_unconditional`.**

It also REFUSES to publish a step whose routing it cannot model. Reachability is only as
good as the edge list, and a missed route makes a conditional step look unconditional —
reporting a branch as drop-off, silently and plausibly. This file models `nextStepId` only
(step-level and per-option); `skipIf`, `branches` / `whenOnly` and `skipNextStepId` raise an
error at publish time.

That guard came from running the algorithm over carnivore-app's real 47-step quiz and
diffing against its independently generated manifest: 3 of 47 steps disagreed, all because
that config uses routing this publisher does not model — and the guard then caught a fourth
construct the diff had missed because it happened to produce the same answer by luck.
Teaching it a new construct means extending `stepEdges()` in
`scripts/publish-quiz-definition-lib.ts`; see `scripts/quiz-step-graph-build.ts` in
carnivore-app for how `skipIf` bypass edges must be attached to a step's PREDECESSORS.

A collapsed branch must still announce itself. Both dashboards surface
`worstArmDropPct` as *"A branch screen here loses N% — show branch screens"*, described in
their own source as avoiding "a lie by omission". Keep `worstArmDropPct` in the payload so
that stays possible.

## Small samples

`smallSample` is set when fewer than 30 people entered, and `biggestLoss` is then chosen by
**absolute people lost** rather than percentage — both products rank this way.
On a funnel that just launched, a confident 21.2% off four sessions is worse than no
number. The app decides; the dashboard renders the caveat it is given.

## What stays the dashboard's job

Three things, and only three:

1. **Fan out** to N apps in parallel and handle one being down without failing the page.
2. **Lay out** — tabs, charts, tables, the pickers driven by `segments`.
3. **Compare across apps** — no app can see another's data. Compare on `positionPct`, not
   `position`: a 7-step funnel and a 14-step funnel are not comparable on absolute index.

## Versioning

`contract` is an integer on every response. A fleet will always have products on different
template versions, and the dashboard must degrade rather than break. Add fields freely
within a version; bump it only on a breaking change, and have the dashboard render the
newest contract it understands per app rather than refusing the whole page.

## Caching

`/api/internal/cro/definition` changes only when `QUIZ_VARIANT` is bumped and the publisher
re-run — by design, the only way a quiz can change. Cache it on `configHash`. Refetch when
a metrics row arrives with an unknown `stepId`, or with `inCatalog: false` — that second one
means an app deployed without running the publisher.

## Status for this template

Three of the four gaps are closed.

**Done.**

1. **`is_unconditional` / `entry_skippable` on `quiz_definition_steps`.** Computed by the
   publisher using reachability-with-the-step-removed, ported from
   `scripts/quiz-step-graph-build.ts` in carnivore-app and glp-app. This is what lets a
   consumer split `companions` from `branches` and stop reporting routing as drop-off. The
   boilerplate schema has no `skipIf` concept, so `entry_skippable` is always false here;
   the column exists because products that do have one need it.

2. **Resolved step labels.** Every string in `quiz-config.ts` is an i18n KEY, not a
   sentence — that is what makes the quiz translatable — so persisting the config faithfully
   yields `steps.step1.question`, no more readable than `step1`. The publisher now loads
   `packages/i18n/messages/en/quiz.json` alongside the config, resolves the key, and stores
   BOTH `label_key` and `label`. Labels are deliberately kept OUT of the config hash: copy
   edits are the most common CRO change and must never force a `quiz_variant` bump.

3. **Zero-traffic steps.** `cro_step_funnel` now builds its row set from the catalog rather
   than from session activity, so every published step appears with `has_traffic: false`
   when nobody reached it. It used to end at the deepest step anyone got to, making "nobody
   reached it" indistinguishable from "it does not exist" — and hiding a routing bug that
   shows a step to zero people. `p90_seconds_to_answer` was added in the same pass.

**Still open — needs new data collection, not a schema change.**

4. **`backEvents` and `errorEvents`.** `sessions.step_activity` is a per-step summary object
   and cannot express an event stream. Both products record these as `quiz_step_events` rows.
   Rendered against a template-backed app those two DetailGrid cells read "—". Choosing
   between extending the JSONB and adopting an event table is a real design call, not a gap
   to plug.

5. **Answers, device, live dwell** — one tab each, surfaced through `capabilities`.

---

# The drop-off response, worked

This is the exact payload `GET /api/internal/cro/funnel` returns, annotated against what
`apps/cro/src/app/dashboard/steps/page.tsx` and `FunnelRows.tsx` actually render in
`carnivore-app` and `glp-app`. Every value those components currently compute is
pre-computed here.

Worked example uses carnivore's position 13, which has both a companion and two branches —
the only shape that exercises the whole row.

```jsonc
{
  "contract": 1,

  "app": {
    "key": "carnidiet",
    "label": "CarniDiet",
    "generatedAt": "2026-09-11T09:00:00Z",
    "capabilities": ["overview", "dropoff"]
  },

  "segments": {
    "funnels":  [{ "id": "main", "label": "Main", "sessions": 4120 }],
    "versions": [
      { "id": "v1", "label": "V1", "sessions": 210,  "firstSeen": "…", "lastSeen": "…" },
      { "id": "v3", "label": "V3", "sessions": 3910, "firstSeen": "…", "lastSeen": "…" }
    ],
    "locales":  [{ "id": "en", "label": "English", "sessions": 3120 }],
    "selected": { "funnel": "main", "version": "v3", "locale": null }
  },

  "range": { "from": "2026-09-04T00:00:00Z", "to": "2026-09-11T00:00:00Z" },

  // Enough structure to validate a cached /definition without fetching it.
  // The full graph — edges, option values, answer keys — stays on /definition,
  // because it changes only on a QUIZ_VARIANT bump while this response changes
  // on every filter click.
  "quiz": {
    "quizVariant": "v3",
    "configHash": "58643ab0fea4…",
    "totalSteps": 33,
    "firstStepId": "step1",
    "terminalStepIds": ["step32"]
  },

  // ── The three stat cards ──────────────────────────────────────────────────
  "totals": {
    "entered": 3910,        // "Started the quiz"   <- enteredFunnel(rows)
    "finished": 968,        // "Reached the end"    <- finishedFunnel(rows)
    "finishPct": 24.8,      // "Finished"           <- finished / started * 100
    "smallSample": false    // isSmallSample(started) — entered < 30
  },

  // ── The "Biggest loss" callout ────────────────────────────────────────────
  // Null when worstStep() is absent or its severity is "normal", which is
  // exactly when the card is not rendered.
  "biggestLoss": {
    "label": "How often do you cook at home?",
    "stepId": "step12b",
    "droppedPeople": 412,
    "dropPct": 31.2,
    "isLeadOfPosition": false,   // false -> "extra screen at question N"
    "displayIndex": 12
  },

  // ── ViewToggles ───────────────────────────────────────────────────────────
  "armCount": 21,           // sum of branches across positions; companions excluded

  // ── One entry per POSITION, already ordered ───────────────────────────────
  "steps": [
    {
      "position": 13,
      "displayIndex": 12,        // rendered ordinal; "—" when retired
      "positionPct": 36.4,       // for cross-app curve overlay only
      "retired": false,
      // False when the step exists in the published quiz but saw no traffic in
      // this window. The app sends the COMPLETE skeleton; the dashboard decides
      // whether to render the empty tail or trim it.
      "hasTraffic": true,

      "reached": 3180,           // "3,180 reached"
      "changeFromPrev": -145,    // "-145 since previous"; omit the line when 0
      "barPct": 81.3,            // reached ÷ totals.entered × 100
      "dropBarPct": 12.4,        // lead.dropped ÷ reached × 100 — the red end of the bar

      "severity": "notable",     // heavy >= 25 | notable >= 10 | normal
      "severityLabel": "Noticeable drop",   // null when normal

      "lead": {
        "stepId": "step12",                       // the row's title tooltip
        "label": "What is your biggest challenge?",
        "kind": "question",
        "viewed": 3180, "answered": 2786, "skipped": 0,
        "dropped": 394, "dropPct": 12.4, "completionPct": 87.6,
        "p50Ms": 4500, "p90Ms": 19000,
        "tag": null,                              // leads carry no arm tag
        "showSkippedNote": false                  // entrySkippable && skipped > 0
      },

      // Everyone walks through these. Always rendered, drop counted at full weight.
      "companions": [
        {
          "stepId": "step12d",
          "label": "Here is what that means for you",
          "kind": "screen",
          "viewed": 2786, "answered": 2740, "skipped": 0,
          "dropped": 46, "dropPct": 1.7, "completionPct": 98.3,
          "p50Ms": 1800, "p90Ms": 5200,
          "tag": "Everyone sees this",
          "shareOfSlotPct": 87.6,
          "severity": "normal",
          "severityLabel": null,
          "showBadge": true                       // viewed >= 30 && !smallSample
        }
      ],

      // Only some visitors routed here. Folded away until ?arms=1.
      "branches": [
        {
          "stepId": "step12b",
          "label": "How often do you cook at home?",
          "kind": "question",
          "viewed": 1320, "answered": 908, "skipped": 0,
          "dropped": 412, "dropPct": 31.2, "completionPct": 68.8,
          "p50Ms": 7100, "p90Ms": 24000,
          "tag": "Only some visitors",
          "shareOfSlotPct": 41.5,                 // of the SLOT, never of entry
          "severity": "heavy",
          "severityLabel": "Most people leave here",
          "showBadge": true
        }
      ],

      "worstArmDropPct": 31.2,
      // Non-null only when a collapsed branch is "heavy" — the exact condition
      // for the "A branch screen here loses N%" line.
      "armAlertPct": 31.2
    }
  ],

  "warnings": []
}
```

## Field-by-field, against the rendered page

| What the page draws | Today | In this contract |
|---|---|---|
| "Started the quiz" | `enteredFunnel(rows)` | `totals.entered` |
| "Reached the end" | `finishedFunnel(rows, graph)` | `totals.finished` |
| "Finished" | `finished / started * 100` in the page | `totals.finishPct` |
| Small-sample caveat | `isSmallSample(started)` | `totals.smallSample` |
| "Biggest loss" card | `worstStep(rows)` + `dropSeverity` | `biggestLoss` (null when not rendered) |
| "extra screen at question N" | `worst.row.step_id === worst.group.lead.step_id` | `biggestLoss.isLeadOfPosition` |
| Toggle count | `rows.reduce(… branches.length)` | `armCount` |
| Row ordinal / "—" | `group.retired ? '—' : displayIndex` | `displayIndex` + `retired` |
| Row title | `stepLabel(lead.step_id)` via a bundled manifest | `lead.label` (resolved by the publisher, not a key) |
| Title tooltip | `lead.step_id` | `lead.stepId` |
| Row badge | `severityLabel(dropSeverity(lead.dropPct))` | `severityLabel` |
| "+N branch" | `group.branches.length` | `branches.length` |
| Bar fill | `barWidthPct(group.reached, max)` | `barPct` |
| Bar red end | `barWidthPct(lead.droppedSessions, group.reached)` | `dropBarPct` |
| "N reached" | `group.reached` | `reached` |
| "N left here (P%)" | `lead.droppedSessions`, `lead.dropPct` | `lead.dropped`, `lead.dropPct` |
| "±N since previous" | `formatChange(group.changeFromPrev)` | `changeFromPrev` |
| "N never saw this question" | `lead.entrySkippable && skipped > 0` | `lead.showSkippedNote` + `lead.skipped` |
| "A branch screen here loses N%" | `dropSeverity(worstArmDropPct)==='heavy'` | `armAlertPct` (null = no line) |
| Arm tag | `arm.unknown ? … : arm.unconditional ? 'Everyone sees this' : 'Only some visitors'` | `tag` |
| Arm badge suppression | `viewed >= 30 && !smallSample` | `showBadge` |
| "P% of this question" | `arm.viewed / group.reached * 100` | `shareOfSlotPct` |
| DetailGrid | `p50_ms`, `p90_ms`, `reanswer_sessions`, `back_events` | `p50Ms`, `p90Ms` — the other two are not collected, see below |
| Retired bucket rows | `[lead, ...branches]` each with viewed/dropped/dropPct | same fields, `retired: true` |

Nothing on that page is left for the dashboard to calculate. The only client-side work
remaining is CSS width from `barPct`, number formatting, and the `?arms=` / `?detail=`
toggles — all genuinely presentation.

## Why zero-traffic steps are included

`buildFunnelView` in both products iterates the RPC rows, not the graph:

```ts
for (const row of rows) {
  const entry = graph.steps[row.step_id];
```

So a step nobody reached in the window produces no bucket and vanishes from the list. "Nobody
got this far" and "this step does not exist" render identically, and the funnel simply ends.

Sending every published step with `hasTraffic: false` fixes that, and makes one specific
failure visible that is currently invisible: traffic at position 14, none at 15, traffic
again at 16 is a ROUTING BUG, not drop-off. Today it draws as an ordinary curve.

## Two naming choices worth stating

**`snake_case` → `camelCase` at the boundary.** The existing types are `snake_case`
because they are raw PostgREST rows. This contract is an HTTP API consumed by one
TypeScript client, so it uses `camelCase` and the app maps once. The dashboard should not
inherit a database's naming.

**`tag`, `severityLabel` and `showBadge` carry English text and a boolean decision.** That
looks like presentation leaking server-side, and it is a deliberate trade: the alternative
is every dashboard re-deriving "Everyone sees this" from `unconditional`, and the 30-view
badge floor from `viewed`. Those two rules are exactly where a fork drifts. If the copy ever
needs translating, the dashboard can map `severity` and a `kind`/`unconditional` pair
itself — both are in the payload for precisely that reason.

## What the template cannot fill yet

`backEvents` and `errorEvents` are **not in the contract**. `sessions.step_activity` is a
per-step summary object and cannot hold an event stream, whereas `quiz_step_events` in both
products can. Rendered against a template app, DetailGrid shows two of its four cells.

A `revisits` count (forward re-entries) was considered as a stand-in for
`reanswer_sessions` and deliberately dropped: it is a different number from
`attempt > 1`, and a hesitation signal in a collapsed panel does not earn a field that
would be silently mismatched across products.

---

# Implementation

Where the contract above actually lives, and the invariants that must survive any change.
**Deviating from any of this requires the protocol at the top of this document.**

## Files

| File | Role |
|---|---|
| `apps/funnel/src/app/api/internal/cro/funnel/route.ts` | The endpoint. Auth, query validation, three parallel reads, hand off to the assembler. |
| `apps/funnel/src/features/cro/funnel-response.ts` | **All the arithmetic.** Pure, no I/O, fully unit-tested. |
| `apps/funnel/src/app/api/internal/cro/_auth.ts` | Fail-closed shared-secret gate, used by all three CRO routes. |
| `supabase/migrations/00001_baseline.sql` → `cro_step_funnel` | Per-step counts, branch-aware, catalog-joined. |
| `supabase/migrations/00001_baseline.sql` → `cro_funnel_segments` | Funnel / version / locale options for the pickers. |
| `scripts/publish-quiz-definition.ts` | Publishes the quiz structure and resolved labels into the catalog. |

## Request

```
GET /api/internal/cro/funnel?from=<iso>&to=<iso>
      [&funnel=][&version=][&locale=][&source=]
x-internal-secret: <this app's INTERNAL_API_SECRET>
```

`from`/`to` **required**, half-open `[from, to)`. `version` defaults to the deployed
`QUIZ_VARIANT` — with no activation flag in the catalog, that constant IS the answer to
"which version is live". Errors: `400 invalid_query | invalid_range | range_too_large`,
`401 unauthorized`, `500 not_configured | query_failed`.

## Invariants

These are the rules a future change must not break. Each one exists because breaking it
produces a plausible-looking wrong number rather than an error.

1. **If a number appears on screen, this app computed it.** The dashboard renders and
   formats; it must never derive a percentage, rank anything, or classify a step.

2. **A position's `reached` is the LEAD's views only** (plus its skips when
   `entry_skippable`). Never the sum across the group — that double-counts companions —
   and never the max, which would mask a data problem. It is an upper bound, not an
   identity: someone who went back and came forward again can appear twice.

3. **Companions and branches are split on `is_unconditional`, never on a shared
   position.** A screen everyone walks through can share a position with another; a
   genuine branch arm can sit alone on one. `is_unconditional` is computed by deleting the
   step and asking whether any terminal is still reachable. Using the position heuristic
   is the single reason a branch gets reported as drop-off.

4. **A branch's drop is measured against its OWN views**, and `shareOfSlotPct` is share of
   the position, never of funnel entry. A screen shown to a third of visitors would
   otherwise read as a 67% cliff.

5. **`finished` counts VIEWS of the terminal step, not answers.** A terminal screen
   advances on its own and is never answered.

6. **Every published step is returned, including ones nobody reached**
   (`hasTraffic: false`). Dropping them makes "nobody got this far" and "this step does not
   exist" render identically, and hides a routing bug that shows a step to zero people.

7. **Steps the catalog no longer knows are bucketed as `retired`** with a null position,
   never given an invented one, and never offered as `biggestLoss`.

8. **Thresholds are 25 / 10 / 30** (heavy drop, notable drop, small sample) and the arm
   floors are 30 (badge) and 20 (alert). These are ported from `presentation.ts` in
   carnivore-app and glp-app so a dashboard built against those keeps reading the same
   numbers. Changing one is a cross-product change.

9. **On a small sample, `biggestLoss` ranks by people lost, not percentage.** A confident
   33% off three sessions is worse than no number.

10. **Errors are 500s, never empty results.** The admin `_queries` convention of logging
    and returning zero exists so an admin *page* still renders; a machine consumer handed
    `0` draws a chart with a cliff in it and nobody notices.

11. **The secret is checked before any database call**, and an unset secret is a
    `500 not_configured`, never a `401` — a misconfiguration must not look like a bad
    credential.

## What this app does not claim

`capabilities` is `["overview", "dropoff"]`. Answers, live dwell and device breakdown need
data the template does not collect, so those tabs are not advertised and the dashboard
hides them rather than rendering empty. A product gains a tab by collecting the data and
adding the capability — no dashboard change.

`backEvents` and `errorEvents` are **not in this response**. `step_activity` is a per-step
summary and cannot hold an event stream. Adding them is a data-collection decision, not a
formatting one.

A `revisits` count was considered as a stand-in and dropped: it answers "did people come
back to this question", which is a hesitation signal in a collapsed panel, not part of the
drop-off curve. `cro_step_funnel` still returns it, so `/step-metrics` exposes it for
anyone who wants it — it is simply not in the assembled funnel.

## Tests that pin this

- `apps/funnel/src/features/cro/__tests__/funnel-response.test.ts` — every invariant above
- `apps/funnel/src/app/api/internal/cro/funnel/__tests__/route.test.ts` — auth, validation,
  envelope, fail-closed behaviour
- `supabase/tests/quiz_backend.sql` — the SQL half: branch arms, zero-traffic rows, label
  resolution, catalog immutability
