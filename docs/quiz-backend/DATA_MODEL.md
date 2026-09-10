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
| `visitor_id`            | TEXT        |       No | Coarse anonymous visitor/install identifier; never authorization |
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
| `attribution`           | JSONB       |      Yes | First-touch campaign/UTM values                                  |
| `client_context`        | JSONB       |      Yes | Bounded device/country/browser context                           |
| `consent_given_at`      | TIMESTAMPTZ |       No | Recorded consent time                                            |
| `consent_version`       | TEXT        |       No | Version of displayed consent copy                                |
| `marketing_consent`     | BOOLEAN     |      Yes | Recorded marketing choice under product policy                   |
| `welcome_email_pending` | BOOLEAN     |      Yes | Handoff flag; quiz module does not send the email                |
| `created_at`            | TIMESTAMPTZ |      Yes | Server creation time                                             |
| `updated_at`            | TIMESTAMPTZ |      Yes | Server last-update time                                          |
| `completed_at`          | TIMESTAMPTZ |       No | Server completion time                                           |

### Example row

```json
{
  "id": "0198d633-48df-7ca8-b728-c4339d29db47",
  "user_id": null,
  "visitor_id": "web_6f9938c8d8e94a6a",
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
    "utm_source": "meta",
    "utm_medium": "paid_social",
    "utm_campaign": "example_launch"
  },
  "client_context": {
    "country": "LT",
    "device_type": "mobile",
    "browser": "Safari"
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

## Why this is two tables

One table alone would mix mutable current state with an unbounded history of actions. Five tables would create unnecessary joins and answer rows for the standard product requirement. Two tables match the existing boilerplate and keep responsibilities clear:

- `sessions`: what is true now;
- `funnel_events`: what happened.
