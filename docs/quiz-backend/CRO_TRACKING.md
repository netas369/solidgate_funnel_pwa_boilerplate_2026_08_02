# CRO Tracking

How this app publishes its quiz structure and per-step activity so an **external
internal CRO dashboard** can read drop-off across many apps built from this template.

> Looking for the plain-English version? [`docs/cro-dropoff.md`](../cro-dropoff.md).

> **Read this first if you are an AI model touching quiz persistence.**
> Nothing here changes where answers live. `sessions.quiz_answers` is still the only
> place an answer is written or read, still one mutable row per journey. The tables
> below hold the quiz's *own structure* — no user data, no per-answer rows, no
> per-view rows. See [DATA_MODEL.md](DATA_MODEL.md) for the answer contract.

## The problem this solves

Two questions the pre-existing schema structurally cannot answer:

**1. What is step 3?** The quiz graph lives only in TypeScript
(`apps/funnel/src/features/quiz/config/quiz-config.ts`). The admin Funnel tab gets away
with this because it runs *inside* the app. An external reader sees
`funnel_events.step_number = 3` and an opaque integer.

**2. Was this a branch or a drop?** Branch arms **share a position** — `step3` and
`step3b` are both position 3 — and `idx_funnel_events_one_step_completion` is unique on
`(session_id, event_type, step_number)`. So one session can record at most one arm, and
the step id survives only inside `metadata.step_id`. `admin/_queries/funnel.ts` already
concedes the consequence: *"raw per-step counts dip there even when nobody actually
dropped."*

And one the funnel events never answered at all: **was the question viewed, or
answered?** `step_completed` fires when a visitor *leaves* a step going forward — and
auto-advancing screens (`checkpoint`, `loading_screen`, `analysis_loader`, `expert_note`,
`social_wall`, `checkpoint_reveal`, `trial_price`) reach it through `goToStepReplace`, so
on those types it already means "displayed", not "answered".

## Two halves

### Half 1 — the definition catalog

Three tables, written only by `scripts/publish-quiz-definition.ts`:

| Table | Key | Holds |
|---|---|---|
| `quiz_definitions` | `quiz_variant` | `app_key`, `funnel_key`, `first_step_id`, `total_steps`, `config_hash` |
| `quiz_definition_steps` | `(quiz_variant, step_id)` | `position`, `sort_index`, `step_type`, `phase_key`, `store_as`, `is_question`, `is_terminal`, `answer_keys`, `label_key`, `label`, `is_unconditional`, `entry_skippable` |
| `quiz_definition_step_edges` | `(quiz_variant, from_step_id, to_step_id, edge_index)` | `on_value` |

About 18 rows for the shipped 8-step quiz. **They do not grow with traffic** — a million
sessions still join to the same 8 step rows.

Five rules that are load-bearing:

- **Keyed on `quiz_variant` alone.** `quiz_variant` is the immutable question set;
  `funnel_variant` is the *independent* per-visitor presentation/offer A/B bucket from
  `assignFunnelVariant(visitorId)`. They are orthogonal axes, not parent and child. One
  definition serves many funnel variants. `funnel_key` is a descriptive family label —
  `sessions` carries no funnel-family column to join on, so it cannot be part of the key.
- **No FK from `sessions`.** Session creation is on the revenue path and must never fail
  because a deploy forgot to seed the catalog. The join is a LEFT JOIN; an unseeded
  variant shows up as `in_catalog: false`, which is how you find out.
- **No unique index on `(quiz_variant, position)`.** Branch arms share a position;
  adding one makes every branching quiz unpublishable. Likewise never upsert on
  `position` — the shipped config has 8 steps and `totalSteps: 7`, so `step3b` would be
  silently lost. `sort_index` is the stable ordering key.
- **Terminal steps publish no edges.** `quiz-config.ts` gives `step7`
  `nextStepId: 'step7'` as an unused placeholder; the no-self-edge CHECK rejects it on
  purpose, or every terminal step becomes a phantom cycle in the reachability graph.
- **`is_question` comes from `allowedKeysForStep(step).length > 0`**
  (`features/quiz/config/step-answer-keys.ts`). That empty-array return is simultaneously
  "no answer keys" and the question-vs-screen classifier. It lives in exactly one place;
  a second copy stops agreeing the moment `quiz-schema.ts` gains a step type, and the
  failure is silent.

### Half 2 — `sessions.step_activity`

One JSONB column. Per step:

```json
{
  "step3": { "viewed_at": "2026-09-11T10:00:19Z", "answered_at": null, "skipped": false, "views": 2 }
}
```

`answered_at: null` on a viewed step is the drop-off signal. `views > 1` means the
visitor came back to it — a strong tell for a confusing question.

**The client sends step IDS ONLY.** There is no timestamp field anywhere in the request
schema, so a skewed or hostile clock cannot move a single value. The server stamps
everything with `now()` inside `quiz_merge_step_activity()`.

**Merge semantics** (pinned by `supabase/tests/quiz_backend.sql`):

| Field | Rule |
|---|---|
| `viewed_at` | `COALESCE` — the FIRST view, never moves |
| `answered_at` | `COALESCE` — the FIRST answer. A visitor who navigates back and edits does **not** reset it. This is "when did they first get past this step", never "last changed". |
| `skipped` | answering clears it; skipping never un-answers |
| `views` | +1 per forward entry, capped at 250 so a looping client cannot inflate it |

**It costs no extra request.** The delta is buffered in the Zustand store
(`pendingStepActivity`) and flushed by the *existing* `save_quiz_session_progress` call —
which already knows both the step being left and the step being entered. Never add a
`fetch` to the step-activity path.

**The delta is per-save, not a cumulative snapshot.** A set has no multiplicity, so a
snapshot cannot carry a view count.

## Publishing

```sh
npx tsx scripts/publish-quiz-definition.ts            # dry run (default)
npx tsx scripts/publish-quiz-definition.ts --apply    # write
npx tsx scripts/publish-quiz-definition.ts --verify   # read back and diff
```

### The workflow this enforces

**There is no activation flag, by design.** Changing the quiz means bumping
`QUIZ_VARIANT` in `features/quiz/server/quiz-definition.ts`; old versions stop receiving
sessions on their own, and several versions being live at once is the normal case rather
than a state anyone toggles.

`config_hash` is what enforces it. Publish a changed config under an unchanged
`quiz_variant` and `publish_quiz_definition()` raises `QUIZ_DEFINITION_DRIFT` and the
publish fails loudly. A published definition is otherwise frozen — a trigger raises
`QUIZ_DEFINITION_IMMUTABLE` on any UPDATE or DELETE — because historical `step_activity`
keys and `funnel_events.step_number` are interpreted against it.

### The publisher refuses routing it cannot model

Reachability decides `is_unconditional`, and it is only as good as the edge list. A MISSED
route makes a conditional step look unconditional — which reports a branch as drop-off,
silently and plausibly.

`stepEdges()` models `nextStepId` only (step-level and per-option). A step carrying
`skipIf`, `branches` / `whenOnly` or `skipNextStepId` fails the publish with a message
naming the construct.

This came from running the algorithm over carnivore-app's real 47-step quiz and diffing
against its independently generated manifest: 3 of 47 steps disagreed, every one because
that config routes in ways this publisher does not model. The guard then immediately caught
a FOURTH construct the diff had missed, because it happened to produce the same answer by
luck. To support one, extend `stepEdges()` in
`scripts/publish-quiz-definition-lib.ts` — and note that `skipIf` bypass edges belong on a
step's PREDECESSORS, not on the step itself (see `scripts/quiz-step-graph-build.ts` in
carnivore-app).

**The hash covers structure, never copy.** Step ids, positions, types, `storeAs`, option
values and branch wiring are hashed. `question` / `subtitle` / `label` are not. Every
string in `quiz-config.ts` is an i18n key, and copy edits are the most common CRO change
there is — if they forced a variant bump, someone would disable the guard within two
months.

## The dashboard contract

The shape an external CRO dashboard actually consumes — both segmentation axes, the
capabilities block, and the display-ready step rows — is specified in
[CRO_DASHBOARD_CONTRACT.md](CRO_DASHBOARD_CONTRACT.md).

## Reading it

Three endpoints, all authenticating with `INTERNAL_API_SECRET` via the `x-internal-secret`
header, and all **fail closed**: an unset secret is a `500 not_configured`, never a 401 that
disguises a misconfiguration as a bad credential. The dashboard never receives a
service-role key — the admin client stays inside the app process.

### `GET /api/internal/cro/funnel?from=&to=` ← what the dashboard actually calls

The display-ready drop-off funnel: one entry per position, branch arms already resolved,
every percentage and badge already computed. This is the one to use. The other two are the
raw surface it is assembled from, kept for drill-down and debugging.

Full specification, including the deviation protocol that governs changes to it:
[CRO_DASHBOARD_CONTRACT.md](CRO_DASHBOARD_CONTRACT.md).

### `GET /api/internal/cro/definition`

Optional `?quizVariant=`, defaulting to the deployed `QUIZ_VARIANT`. Returns each step
with `position`, `type`, `isQuestion`, `isTerminal`, `nextSteps`, `answerKeys` and
`sharesPositionWith`, plus a `live` block naming what this deployment writes onto new
sessions right now.

### `GET /api/internal/cro/step-metrics?from=&to=`

`from`/`to` are **required** and half-open `[from, to)`. Optional `quizVariant`,
`funnelVariant`, `source`. Backed by `cro_step_funnel()`.

Per step: `viewed`, `answered`, `skipped`, `advanced`, `dropped`, `unsettled`,
`positionCohort`, `totalViews`, `revisits`, `p50SecondsToAnswer`, `inCatalog`.

**Rows are keyed by `stepId`, never `stepNumber`** — that is the entire fix. Join to the
definition on `stepId`:

- **branch** — arms sharing a `position`; their `viewed` sums to roughly
  `positionCohort`, and nothing was lost.
- **drop** — `dropped` counts sessions that viewed this step, viewed **none** of its
  successor edges, and did not complete.
- **unsettled** — viewed, not advanced, but too recent to call abandoned
  (`p_settled_after`, default 2h). Excluded from `dropped` on purpose: without it, any
  window touching `now()` overstates drop-off on whatever step the newest cohort is
  sitting on.

## Known gaps — documented, not bugs

- `goBack()` does not save, so `views` counts **forward entries only**. A write on
  back-navigation would be a new request.
- A visitor who lands and abandons **without advancing** never flushes the landing
  `viewed`. The `sessions` row still exists with `current_step_id`, so the landing stays
  countable; flushing on `beforeunload` would be a new network call.
- `step-metrics` filters `sessions.created_at`, not `updated_at` (which moves on every
  save, so a range over it is not reproducible), and does **not** filter `source = 'quiz'`
  unlike `funnelStageSummary.started`. Expect a deliberate discrepancy with the admin
  Funnel tab.
- Retried session creation mints a new `sessionId`, so `viewed` at position 1 ≈ session
  count, not visitor count.
- Unknown step ids in a save are **dropped with a warning, not rejected**. A stale tab
  would otherwise 400 forever — its buffer never clearing — and stop persisting the
  visitor's answers. Telemetry must never cost answers.
- There is deliberately **no rollup table**. GDPR deletions cascade from `sessions` to
  `funnel_events`, so historical drop-off figures erode as buyers exercise deletion. This
  was an explicit product decision.

## Deploy order

1. Apply the migration.
2. `supabase gen types --local --schema public` — the app cannot compile before this.
3. `npx tsx scripts/publish-quiz-definition.ts --apply` — **before** the first session
   writes `step_activity`, or the dashboard collects metrics it cannot label.
4. Deploy the app.

App-before-migration is a **total outage**: the client sends the extra RPC parameter, only
the 13-argument function exists, PostgREST returns `PGRST202`, and every quiz save 500s.
