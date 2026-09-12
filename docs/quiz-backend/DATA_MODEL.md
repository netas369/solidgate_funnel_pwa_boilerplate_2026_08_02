# Data Model

## Relationship

```text
sessions (one row per quiz journey)
  1
  |
  +---- many funnel_events (milestone history)
```

## `public.sessions`

This is the current truth. Every save updates the same row.

A valid visitor receives this row when the Quiz screen becomes active, even when they close it without clicking. That empty, inactive row is intentional evidence for first-screen drop-off. Known Meta crawlers are rejected by the create API before reaching this table; real Facebook and Instagram in-app browsers remain valid visitors.

| Column                  | Type        | Required | Purpose                                                          |
| ----------------------- | ----------- | -------: | ---------------------------------------------------------------- |
| `id`                    | UUID        |      Yes | Session primary key                                              |
| `user_id`               | UUID        |       No | Authenticated owner after linking                                |
| `visitor_id`            | TEXT        |       No | New Quiz API creates a stable browser UUID; never authorization  |
| `email`                 | TEXT        |       No | Normalized captured email; not proof of ownership                |
| `quiz_answers`          | JSONB       |      Yes | Complete current answer object                                   |
| `quiz_result`           | JSONB       |       No | Final server-computed result                                     |
| `result_segment`        | TEXT        |       No | Stable top-level result code used by funnel consumers            |
| `current_step_id`       | TEXT        |       No | Current or last persisted stable step key                        |
| `status`                | TEXT        |      Yes | `active`, `completed`, `abandoned`, or `expired`                 |
| `revision`              | INTEGER     |      Yes | Optimistic concurrency counter                                   |
| `quiz_variant`          | TEXT        |      Yes | Immutable questions, branching and scoring version               |
| `funnel_variant`        | TEXT        |      Yes | Immutable funnel presentation/offer version                      |
| `locale`                | TEXT        |      Yes | Current language/locale                                          |
| `source`                | TEXT        |      Yes | Entry route such as `quiz` or `special-offer`                    |
| `attribution`           | JSONB       |      Yes | First/last-touch campaign and click identifiers                  |
| `client_context`        | JSONB       |      Yes | Bounded server-observed device, network and location context     |
| `consent_given_at`      | TIMESTAMPTZ |       No | Recorded consent time                                            |
| `consent_version`       | TEXT        |       No | Version of displayed consent copy                                |
| `marketing_consent`     | BOOLEAN     |      Yes | Recorded marketing choice under product policy                   |
| `welcome_email_pending` | BOOLEAN     |      Yes | Handoff flag; quiz module does not send the email                |
| `created_at`            | TIMESTAMPTZ |      Yes | Server creation time                                             |
| `updated_at`            | TIMESTAMPTZ |      Yes | Server last-update time                                          |
| `completed_at`          | TIMESTAMPTZ |       No | Server completion time                                           |
| `step_activity`         | JSONB       |      Yes | Per-step viewed/answered/skipped/views. Timestamps, never answers |

### Example row

```json
{
  "id": "0198d633-48df-7ca8-b728-c4339d29db47",
  "user_id": null,
  "visitor_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "email": "alex@example.com",
  "quiz_answers": {
    "gender": "female",
    "primaryGoal": "a",
    "challenges": ["o1", "o2"],
    "fullName": "Alex Example",
    "email": "alex@example.com"
  },
  "quiz_result": null,
  "result_segment": null,
  "current_step_id": "step7",
  "status": "active",
  "revision": 3,
  "quiz_variant": "boilerplate-v1",
  "funnel_variant": "main-v1",
  "locale": "en",
  "source": "quiz",
  "attribution": {
    "first_touch": {
      "utm_source": "meta",
      "utm_medium": "paid_social",
      "utm_campaign": "example_launch",
      "utm_content": "video-a",
      "utm_term": "audience-a",
      "fbclid": "example_click_id"
    },
    "last_touch": {
      "utm_source": "meta",
      "utm_medium": "paid_social",
      "utm_campaign": "retargeting"
    },
    "fbc": "fb.1.1789113600000.example_click_id",
    "fbp": "fb.1.1789113600000.123456789"
  },
  "client_context": {
    "country": "LT",
    "region": "VL",
    "city": "Vilnius",
    "timezone": "Europe/Vilnius",
    "device_type": "mobile",
    "browser": "Safari",
    "platform": "iOS",
    "browser_language": "lt-LT",
    "ip_address": "203.0.113.12",
    "user_agent": "Mozilla/5.0 (...) Mobile Safari/604.1"
  },
  "consent_given_at": "2026-09-09T10:10:00Z",
  "consent_version": "2026-09-01",
  "marketing_consent": true,
  "welcome_email_pending": true,
  "created_at": "2026-09-09T10:00:00Z",
  "updated_at": "2026-09-09T10:12:00Z",
  "completed_at": null
}
```

### Answer JSON rules

- Keys are stable, untranslated identifiers.
- Values are JSON strings, numbers, booleans, or bounded arrays/objects allowed by the versioned definition.
- Store canonical units, for example centimeters rather than a locale-formatted height string.
- Do not store labels translated for the UI as canonical values.
- A save replaces the previous answer object only after full validation and a successful revision check.
- Maximum recommended serialized size is 64 KiB per session unless a product explicitly documents another bound.

### Result JSON rules

- Only the backend writes `quiz_result` and `result_segment` during completion.
- The result contains the score version and only the values downstream pages need.
- A completed result is immutable. New scoring rules require a new `quiz_variant` or a deliberate recalculation workflow.

### Immutable creation fields

`quiz_variant`, `funnel_variant`, original `source`, and first-touch `attribution` must not be replaced by ordinary progress saves. `locale` may change when the product supports a mid-quiz language switch.

`visitor_id` comes from a one-year HTTP-only first-party cookie. It lets multiple journeys from the same browser receive the same experiment assignment, but it is not login proof and can change when cookies are cleared.

`source` is the internal entry surface (`quiz`, `main`, `advertorial`, `special-offer`, or `special-offer-free`). It is deliberately separate from `utm_source`, which names an external campaign provider such as Meta or Google.

`client_context.ip_address` is the public IP observed by the deployment platform. It can represent a VPN, proxy, mobile carrier or shared network and must never be treated as an exact person or device identifier. Because IP and approximate location are personal data, production retention, access and deletion rules must cover this JSON field.

### Funnel A/B assignment

`funnel_variant` is assigned on the server from the stable visitor UUID. Configure weighted variants with `FUNNEL_VARIANT_WEIGHTS`, for example `control-v1:50,treatment-v1:50`, and identify the experiment with `FUNNEL_EXPERIMENT_KEY`. Missing or malformed configuration safely falls back to `main-v1`.

The assignment is returned to the Quiz client and retained with the session, so the UI can choose the matching presentation without choosing its own bucket. `quiz_variant` has a different job: it identifies the immutable question, branching and scoring definition. A new question set must be implemented as a supported version before it can be assigned.

## `public.funnel_events`

This table stores history, not current state.

| Column        | Type        | Required | Purpose                               |
| ------------- | ----------- | -------: | ------------------------------------- |
| `id`          | UUID        |      Yes | Database primary key                  |
| `event_id`    | UUID        |      Yes | Client/server idempotency key, unique |
| `session_id`  | UUID        |      Yes | Owning session                        |
| `event_type`  | TEXT        |      Yes | Name from `EVENT_CATALOG.md`          |
| `step_number` | INTEGER     |       No | Step position relevant to the event   |
| `metadata`    | JSONB       |      Yes | Small event-specific properties       |
| `occurred_at` | TIMESTAMPTZ |      Yes | When the action occurred              |
| `created_at`  | TIMESTAMPTZ |      Yes | When the database received it         |

### Example rows

```json
[
  {
    "event_id": "0198d633-0000-7000-8000-000000000001",
    "session_id": "0198d633-48df-7ca8-b728-c4339d29db47",
    "event_type": "quiz_started",
    "step_number": 1,
    "metadata": {},
    "occurred_at": "2026-09-09T10:00:00Z"
  },
  {
    "event_id": "0198d633-0000-7000-8000-000000000002",
    "session_id": "0198d633-48df-7ca8-b728-c4339d29db47",
    "event_type": "step_completed",
    "step_number": 3,
    "metadata": { "step_id": "step3" },
    "occurred_at": "2026-09-09T10:12:00Z"
  }
]
```

### Event JSON rules

- Maximum recommended metadata size is 8 KiB.
- Never include the full answer object, email, IP address, session credential, auth token, or payment data.
- A unique `event_id` makes retry safe.
- Events are append-only. Correct an analytical mistake with a new deliberate event or reporting rule, not by rewriting history.

## `sessions.step_activity`

Per-step CRO telemetry, keyed by `step_id`:

```json
{ "step3": { "viewed_at": "…", "answered_at": null, "skipped": false, "views": 2 } }
```

It answers the one question `funnel_events` cannot: was a question **viewed** or
**answered**? `answered_at: null` on a viewed step is the drop-off signal.

The client sends step IDS ONLY — the server stamps every timestamp with `now()` inside
`quiz_merge_step_activity()`, merged in the same revision-guarded UPDATE as the answers.
`viewed_at` and `answered_at` are both FIRST-wins and never move.

This is NOT a second home for answers, and it is NOT an event log — it is a bounded
object on the existing row, one entry per step. See [CRO_TRACKING.md](CRO_TRACKING.md).

## The definition catalog is not part of this contract

`quiz_definitions`, `quiz_definition_steps` and `quiz_definition_step_edges` describe the
quiz's own structure, so the app's CRO dashboard can label a step and tell a branch apart
from a drop after the quiz has moved on. They hold **no user data**,
carry roughly 18 rows per quiz version, and do not grow with traffic. `sessions` has no FK
to them by design. See [CRO_TRACKING.md](CRO_TRACKING.md).

## Why this is two tables

One table alone would mix mutable current state with an unbounded history of actions. Five tables would create unnecessary joins and answer rows for the standard product requirement. Two tables match the existing boilerplate and keep responsibilities clear:

- `sessions`: what is true now;
- `funnel_events`: what happened.
