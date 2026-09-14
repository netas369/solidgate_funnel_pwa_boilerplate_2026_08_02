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
tables — the *catalog* — says what each code means: the question text, its answer options
and their wording, where it sits, and whether everyone sees it or only some people. One
catalog per quiz version, so last month's data still reads correctly after you change the
quiz.

**3. The dashboard renders it.** Two calls do the work, and the dashboard draws the result.

## The dashboard

It is already built: `apps/cro`, on port 3207, with five tabs — Overview, Drop-off,
Right now, Answers, and Language & device.

```sh
npm run dev:cro     # http://localhost:3207
```

**It holds no god-mode key.** The board signs in with an email code and then carries
only the public anon key, exactly like the funnel does. What makes it work is a short
list of analysts:

```sql
INSERT INTO cro_analysts (email, note) VALUES ('you@example.com', 'CRO');
```

Adding a colleague is that one line — no redeploy, no key to hand over. Anyone not on
the list gets a "your account is not on the analyst list" message rather than an empty
board, and the anon key on its own can read nothing at all. A test fails the build if a
service-role key is ever referenced from this app.

### Opening it from PMC Hub

A plain link works — the analyst signs in with a code like anywhere else. To skip
that, PMC Hub can ask the product's funnel for a one-time link:

```
POST https://<funnel>/api/internal/cro-login-link
x-internal-secret: <that product's INTERNAL_API_SECRET>
{ "email": "analyst@example.com" }

→ { "url": "https://cro.<product>/sso?token=..." }
```

Redirect the browser there and the board opens signed in.

**Call it when the link is clicked, not when the page renders.** The token is
single-use and short-lived; a hub page that embeds a freshly minted link in every
row puts a live credential in the HTML for every analyst it lists.

**The secret cannot grant access.** An address that is not already in
`cro_analysts` is refused before a link exists, so the worst a leaked secret does
is open a board for someone who could already open it. That is the reason this
endpoint lives on the funnel rather than PMC Hub holding each product's
service-role key — which would make one internal app a full-database credential
for every product.

Any failure — stale link, reused link, access revoked since it was minted — lands
on the normal sign-in page with a line saying why.

### Filters

Three, and two of them behave in opposite ways:

| | Absent means | Combining them |
|---|---|---|
| **Funnel** | every funnel | fine — same questions, different presentation |
| **Quiz version** | the version running now | only where the tab offers it |
| **Market** | every market | fine |

Combining two quiz *versions* is the dangerous one: they ask different questions and
number them differently, so a merged funnel chart describes neither. The two
funnel-shaped tabs simply do not offer it.

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
stores a summary per question instead. Going back also doesn't save, so on the live tab
someone who returned to an earlier question still shows on the last one they moved
forward into.

**No free-text answers, ever.** The Answers tab runs an allowlist of multiple-choice
question types. Everything else — emails, names, anything typed — reports how many people
completed it and nothing more. That is a rule in the database, not a habit of the page.

**No "changed their mind" chart.** A session stores each answer's final value, not a
history of it.

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

**"Your account is not on the CRO analyst list."** The sign-in worked; the address just
isn't in `cro_analysts`. Add it with the INSERT above.

**An answer shows as `o1` rather than words.** That version was published before option
wording was carried, or the option has since been removed — a removed one says so on the
row. Either way the count is right.

**The dashboard says fewer starts than you expected.** A visit that opened the quiz and
left before answering anything records no activity, so it is not in the funnel. Overview
states that number separately rather than folding it in.

## Where the detail lives

| | |
|---|---|
| `docs/quiz-backend/CRO_TRACKING.md` | how recording and the catalog work |
| `docs/quiz-backend/DATA_MODEL.md` | the session and event tables |
| `apps/cro/src/lib/filters.ts` | why the three filters behave differently |
| `packages/shared/src/cro/funnel-response.ts` | the maths behind every number on screen |
