# Quiz Backend API Contract

Route paths may be adapted to the host framework, but the behavior below is the reusable contract.

## Shared rules

- Requests and responses use JSON.
- Server timestamps are ISO-8601 UTC.
- The server derives `user_id`, timestamps, completion state, and result values.
- Anonymous reads and writes require a signed, expiring session credential.
- Every update to current state supplies `expectedRevision`.
- A stale revision returns `409 STALE_SESSION_REVISION`; it never silently overwrites newer data.
- Size and quiz-definition validation run before a database write.

Standard error:

```json
{
  "error": {
    "code": "INVALID_QUIZ_ANSWERS",
    "message": "The answer snapshot is invalid.",
    "fields": {"height_cm": "OUT_OF_RANGE"}
  }
}
```

## `POST /api/session/create`

Creates exactly one session row.

Request:

```json
{
  "visitorId": "web_6f9938c8d8e94a6a",
  "quizVariant": "example-v1",
  "funnelVariant": "main-a",
  "locale": "en",
  "source": "quiz",
  "attribution": {
    "utm_source": "meta",
    "utm_medium": "paid_social",
    "utm_campaign": "example_launch"
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
    "revision": 0
  },
  "sessionToken": "signed-expiring-token"
}
```

The server validates known variants, captures bounded client context, and makes create idempotent for the supplied session identity.

## `POST /api/session/persist`

Updates the existing row with the complete current answer snapshot.

Request:

```json
{
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "expectedRevision": 2,
  "currentStepId": "activity_level",
  "answers": {
    "gender": "female",
    "diet_familiarity": "beginner",
    "activity_level": "light"
  },
  "event": {
    "eventId": "0198d633-0000-7000-8000-000000000002",
    "type": "step_completed",
    "stepNumber": 3,
    "metadata": {"step_id": "activity_level"}
  }
}
```

Successful backend flow:

1. Authenticate or verify the signed session credential.
2. Load the session and require `status = active`.
3. Compare `expectedRevision` with `sessions.revision`.
4. Validate the entire snapshot against `sessions.quiz_variant`.
5. Update `quiz_answers`, `current_step_id`, `updated_at`, and `revision = revision + 1`.
6. Insert the optional allowed event using its unique `event_id`.
7. Commit the state and event together.

Response `200`:

```json
{
  "ok": true,
  "sessionId": "0198d633-48df-7ca8-b728-c4339d29db47",
  "revision": 3,
  "currentStepId": "activity_level"
}
```

If `expectedRevision` is stale, response `409` includes the current safe state so the client can reconcile. The client should normally serialize saves, making this conflict exceptional rather than routine.

## `GET /api/session/read?sessionId=:sessionId`

Requires authenticated ownership or the signed session credential.

Response `200`:

```json
{
  "id": "0198d633-48df-7ca8-b728-c4339d29db47",
  "status": "active",
  "currentStepId": "activity_level",
  "answers": {
    "gender": "female",
    "diet_familiarity": "beginner",
    "activity_level": "light"
  },
  "result": null,
  "resultSegment": null,
  "quizVariant": "example-v1",
  "funnelVariant": "main-a",
  "locale": "en",
  "revision": 3
}
```

Do not return event history by default. It is not required to resume the quiz.

## `POST /api/session/complete`

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
    "score_version": "example-v1",
    "profile": "balanced",
    "scores": {"consistency": 72, "readiness": 64}
  },
  "result_segment": "balanced",
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
  "resultSegment": "balanced",
  "result": {
    "score_version": "example-v1",
    "profile": "balanced",
    "scores": {"consistency": 72, "readiness": 64}
  },
  "completedAt": "2026-09-09T10:20:00Z"
}
```

## `POST /api/session/link-user`

Requires authentication. The server reads the user from the trusted authentication context; the request cannot provide a different user ID.

Request:

```json
{"sessionId": "0198d633-48df-7ca8-b728-c4339d29db47"}
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

The backend validates authorization, event name, metadata, and size. Reusing the same `eventId` returns success without inserting another row. Clients cannot emit server-owned events such as `quiz_completed` or payment-confirmed events.

## Recommended limits

| Item | Limit |
|---|---:|
| Complete `quiz_answers` snapshot | 64 KiB |
| Complete `quiz_result` | 64 KiB |
| Event metadata | 8 KiB |
| Email | 320 characters |
| Locale | 35 characters |
| Variant/source/step key | 100 characters |
| One attribution string | 255 characters |
