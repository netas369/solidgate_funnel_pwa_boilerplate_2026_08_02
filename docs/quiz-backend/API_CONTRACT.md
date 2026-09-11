# Quiz Backend API Contract

Route paths may be adapted to the host framework, but the behavior below is the reusable contract.

## Shared rules

- Requests and responses use JSON.
- Server timestamps are ISO-8601 UTC.
- The server derives `user_id`, timestamps, completion state, and result values.
- Anonymous reads and writes require a signed, expiring session credential.
- The Quiz credential is signed only with `QUIZ_SESSION_COOKIE_SECRET`, which must contain at least 32 characters and must not be reused as `PAYMENT_COOKIE_SECRET`.
- A Payment cookie does not grant access to Quiz sessions.
- Every update to current state supplies `expectedRevision`.
- A stale revision returns `409 STALE_SESSION_REVISION`; it never silently overwrites newer data.
- Size and quiz-definition validation run before a database write.
- Event metadata containing answer/result payloads, email, IP, credentials, or card/payment-secret fields is rejected before a database write.
- Session creation remains tied to Quiz screen activation, not the first click, so visitors who leave without interacting remain measurable.
- Known Meta crawler User-Agent tokens are rejected before cookie signing and database access. `fbclid`, Meta referrers, and Facebook/Instagram in-app browser tokens are not bot signals.

Standard error:

```json
{
  "error": {
    "code": "INVALID_QUIZ_ANSWERS",
    "message": "The saved answers are invalid.",
    "fields": { "primaryGoal": "INVALID_OPTION" }
  }
}
```

The reference quiz frontend persists the returned `revision`, serializes saves per session, requires a successful lead save before leaving the email screen, and waits for the final save plus completion before leaving the quiz. It never writes quiz milestones directly to `funnel_events`.

## `POST /api/quiz/session/create`

Creates exactly one session row.

Request:

```json
{
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "locale": "en",
  "source": "quiz",
  "attribution": {
    "first_touch": {
      "utm_source": "meta",
      "utm_medium": "paid_social",
      "utm_campaign": "example_launch",
      "fbclid": "example_click_id",
      "landing_url": "https://example.com/en/quiz?utm_source=meta",
      "captured_at": "2026-09-11T08:00:00.000Z"
    },
    "last_touch": {
      "utm_source": "meta",
      "utm_medium": "paid_social",
      "utm_campaign": "example_launch",
      "fbclid": "example_click_id",
      "captured_at": "2026-09-11T08:00:00.000Z"
    },
    "fbc": "fb.1.1789113600000.example_click_id",
    "fbp": "fb.1.1789113600000.123456789"
  }
}
```

Response `201`:

```json
{
  "session": {
    "id": "0198d633-48df-7ca8-b728-c4339d29db47",
    "status": "active",
    "currentStepId": null,
    "answers": {},
    "revision": 0,
    "quizVariant": "boilerplate-v1",
    "funnelVariant": "main-v1",
    "source": "quiz"
  },
  "persisted": {
    "id": "0198d633-48df-7ca8-b728-c4339d29db47",
    "status": "active",
    "revision": 0,
    "current_step_id": null
  }
}
```

`sessionId` is optional; the server generates it when omitted. The caller cannot supply `visitorId`: the server creates or reuses the one-year HTTP-only `funnel_visitor_id` cookie. A successful response also sets the signed, HTTP-only `quiz_session_access` cookie. Reusing a session ID returns `409 SESSION_ALREADY_EXISTS` rather than taking ownership of the existing session.

`quizVariant` remains the server-owned immutable Quiz definition. `funnelVariant` is assigned server-side using the visitor cookie and optional `FUNNEL_VARIANT_WEIGHTS`; the caller cannot select either variant. The returned values are the source of truth for rendering and analytics.

`source` describes the internal page that sent the visitor into Quiz and is separate from external `utm_source`. The supported values are `quiz`, `main`, `advertorial`, `special-offer`, and `special-offer-free`.

The server also stores request-derived context in `client_context`: device type, browser, platform, browser language, country/region/city/timezone headers, public request IP and User-Agent. These values are not trusted authorization data and are not returned by the read endpoint.

Known Meta crawler response `204` has no body, sets no cookie, and creates neither a `sessions` row nor a `quiz_started` event. The frontend treats it as a non-persistent public render and emits no Quiz analytics. A real visitor using the Facebook or Instagram in-app browser still receives the normal `201` response and is tracked even if they leave before clicking.

## `POST /api/quiz/session/save`

Updates the existing row with the complete current answer object. Despite the full object being sent, this remains one row in `sessions`.

Request:

```json
{
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "expectedRevision": 2,
  "currentStepId": "step4",
  "answers": {
    "gender": "female",
    "primaryGoal": "a",
    "challenges": ["o1", "o2"]
  },
  "event": {
    "eventId": "0198d633-0000-7000-8000-000000000002",
    "type": "step_completed",
    "stepNumber": 3,
    "metadata": { "step_id": "step3" }
  }
}
```

Successful backend flow:

1. Authenticate or verify the signed session credential.
2. Load the session and require `status = active`.
3. Compare `expectedRevision` with `sessions.revision`.
4. Validate all submitted answers against `sessions.quiz_variant`.
5. Reject a normal save that removes a previously saved answer key.
6. Update `quiz_answers`, `current_step_id`, `updated_at`, and `revision = revision + 1`.
7. Insert the optional allowed event using its unique `event_id`.
8. Commit the state and event together.

Response `200`:

```json
{
  "ok": true,
  "revision": 3,
  "currentStepId": "step4",
  "status": "active"
}
```

If `expectedRevision` is stale, response `409` includes `currentRevision`. The client can then perform an authorized read and reconcile. The client should normally serialize saves, making this conflict exceptional rather than routine.

### Optional `stepActivity` on save

```json
{
  "stepActivity": {
    "activityId": "0198d633-0000-7000-8000-00000000000a",
    "viewed": ["step3"],
    "answered": ["step2"],
    "skipped": []
  }
}
```

Step IDS ONLY — there is deliberately no timestamp field, so a client clock cannot move
`viewed_at` or `answered_at`. `viewed` keeps duplicates (they are the view counter);
`answered` and `skipped` are deduped. Arrays are capped at 200 and an over-length array is
a `400`. Unknown step ids are **dropped with a warning and the save still succeeds** — a
stale tab must never be locked out of persisting the visitor's answers. `activityId` makes
a retried save idempotent for the merge.

## `GET /api/quiz/session/read?sessionId=:sessionId`

Requires authenticated ownership or the signed session credential.

Response `200`:

```json
{
  "id": "0198d633-48df-7ca8-b728-c4339d29db47",
  "status": "active",
  "current_step_id": "step4",
  "quiz_answers": {
    "gender": "female",
    "primaryGoal": "a",
    "challenges": ["o1", "o2"]
  },
  "quiz_result": null,
  "result_segment": null,
  "quiz_variant": "boilerplate-v1",
  "funnel_variant": "main-v1",
  "locale": "en",
  "source": "quiz",
  "revision": 3
}
```

Do not return event history by default. It is not required to resume the quiz.

## `POST /api/quiz/session/complete`

Request:

```json
{
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "expectedRevision": 7
}
```

The backend authorizes the caller, validates every required reachable answer, calculates the result, and atomically updates the session:

```json
{
  "quiz_result": {
    "score_version": "boilerplate-v1",
    "profile": "a",
    "answered_questions": 5
  },
  "result_segment": "a",
  "status": "completed",
  "current_step_id": "results",
  "completed_at": "2026-09-09T10:20:00Z",
  "revision": 8
}
```

The same transaction inserts one `quiz_completed` event. A repeated completion request returns the existing stored result without recomputation or another event.

Response `200`:

```json
{
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "status": "completed",
  "revision": 8,
  "resultSegment": "a",
  "result": {
    "score_version": "boilerplate-v1",
    "profile": "a",
    "answered_questions": 5
  },
  "completedAt": "2026-09-09T10:20:00Z"
}
```

## `POST /api/quiz/session/link-user`

Requires authentication. The server reads the user from the trusted authentication context; the request cannot provide a different user ID.

Request:

```json
{ "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47" }
```

The operation is idempotent for the same user. If a different user already owns the session, return `409 SESSION_OWNERSHIP_MISMATCH`.

## `POST /api/funnel-events`

Use only for approved client-observable milestones that are not already written inside another session transaction.

Request:

```json
{
  "eventId": "0198d633-0000-7000-8000-000000000003",
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "type": "results_viewed",
  "stepNumber": null,
  "metadata": {}
}
```

The backend validates authorization, event name, metadata, size, and any client timestamp. Client timestamps may be at most seven days old or five minutes in the future. Reusing the same `eventId` returns success without inserting another row. Clients cannot emit server-owned events such as `quiz_completed` or `checkout_completed`.

## CRO endpoints (internal)

Both authenticate with `INTERNAL_API_SECRET` via the `x-internal-secret` header and fail
closed — an unset secret is `500 not_configured`, never a 401. They exist so an external
CRO dashboard can read per-step drop-off without holding a service-role key. Full
contract: [CRO_TRACKING.md](CRO_TRACKING.md).

### `GET /api/internal/cro/definition`

Optional `quizVariant` (defaults to the deployed `QUIZ_VARIANT`). Returns the published
quiz structure: each step's `position`, `type`, `isQuestion`, `isTerminal`, `nextSteps`,
`answerKeys` and `sharesPositionWith`, plus a `live` block. `404 not_published` when the
variant has never been published.

### `GET /api/internal/cro/step-metrics?from=&to=`

`from` and `to` are required, half-open `[from, to)`. Optional `quizVariant`,
`funnelVariant`, `source`. Per step: `viewed`, `answered`, `skipped`, `advanced`,
`dropped`, `unsettled`, `positionCohort`, `totalViews`, `revisits`,
`p50SecondsToAnswer`, `inCatalog`. Rows are keyed by `stepId`, never `stepNumber`.
Errors: `400 invalid_query` / `invalid_range` / `range_too_large`, `500 query_failed`.

## Recommended limits

| Item                             |          Limit |
| -------------------------------- | -------------: |
| Complete `quiz_answers` object   |         64 KiB |
| Complete `quiz_result`           |         64 KiB |
| Event metadata                   |          8 KiB |
| Email                            | 320 characters |
| Locale                           |  35 characters |
| Variant/source/step key          | 100 characters |
| One attribution string           | 500 characters |
