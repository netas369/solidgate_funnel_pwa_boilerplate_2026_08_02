# Backend Structure

## 1. Implemented responsibility layers

```text
API routes
  -> authorization, validation and scoring helpers
  -> service-role PostgreSQL RPC
  -> sessions + funnel_events
```

### API routes

Routes parse HTTP requests, coordinate the use case, call a fixed database RPC, and translate known failures into stable HTTP responses. They must not contain product scoring rules or construct arbitrary database updates directly from the request body.

### Server helpers

The helpers in `features/quiz/server` own session authorization, versioned answer validation, deterministic scoring, server-observed client context, stable experiment assignment, and standard error responses. Keeping those rules outside route files makes them reusable and directly testable.

### Authorization

Authorization establishes whether the caller may use the requested session. Supported paths are:

- an authenticated user owns `sessions.user_id`; or
- an anonymous caller presents a signed, expiring credential bound to that session.

Knowing a session UUID is not sufficient authorization.

### Validation

Validation loads the immutable definition named by `sessions.quiz_variant`. It verifies question keys, answer types, allowed option codes, numeric bounds, arrays, required questions, and branching. It also applies request-size limits.

### Scoring

Scoring is deterministic server code. It reads the validated stored answers and the matching versioned quiz definition. The client never supplies a trusted final result.

### Database RPCs

Service-role SQL functions are the transaction boundary for multi-write operations. They update `sessions`, write required `funnel_events`, enforce revision checks, and handle event idempotency atomically. API routes may perform an authorized read before calling a fixed RPC; they never accept a table or column name from the client.

## 2. Current source layout

The implemented backend is intentionally compact:

```text
apps/funnel/src/app/api/
  quiz/session/create/route.ts
  quiz/session/save/route.ts
  quiz/session/read/route.ts
  quiz/session/complete/route.ts
  quiz/session/link-user/route.ts
  funnel-events/route.ts

apps/funnel/src/features/quiz/server/
  quiz-access.ts
  quiz-definition.ts
  quiz-scoring.ts
  client-context.ts
  experiment-assignment.ts
  meta-crawler.ts
  http.ts

packages/shared/src/
  quiz-session-cookie.ts

supabase/migrations/
  00001_baseline.sql

supabase/tests/
  quiz_backend.sql
```

Do not add repository or service wrapper files merely to mirror an abstract architecture. Split these helpers only when additional quiz variants or consumers create a real reuse boundary.

## 3. Main operations

### Create

`createQuizSession()` is called when the Quiz screen becomes active, before the visitor must click anything. This keeps zero-interaction exits measurable. The route first rejects known Meta crawler User-Agent tokens without creating a row, cookie, or event. For a normal browser it creates or reuses a stable anonymous visitor UUID, assigns the funnel variant on the server, captures entry/campaign attribution and request context, creates one `sessions` row, issues an anonymous session credential, and emits `quiz_started`.

The stable visitor UUID is used for experiment consistency only. It never authorizes a read or write. Device type, browser, public IP and approximate Vercel/Cloudflare location are observations used for analytics, not trusted identity facts.

This crawler check is an analytics-quality filter, not authentication. Real Facebook and Instagram in-app browsers are allowed, and every Quiz read or write still requires its normal signed-session or authenticated-owner credential.

### Save progress

`saveQuizProgress()` authorizes the session, checks its revision and active status, validates the complete answer object, updates the same session row, increments the revision, and optionally inserts one idempotent milestone event.

### Read

`readQuizSession()` authorizes the caller and returns safe resumable fields: answers, current step, variants, entry source, result when completed, and the current revision. Raw IP, User-Agent, internal metadata and credentials are never returned.

### Complete

`completeQuizSession()` validates all required reachable questions, computes the result on the server, saves the result on the same session row, marks it complete, and inserts `quiz_completed` in one transaction. A retry returns the already stored result.

### Link user

`linkSessionToUser()` uses the authenticated principal from the server session. The client cannot select an arbitrary `user_id`. A session already owned by another user cannot be reassigned.

### Record event

`recordFunnelEvent()` accepts a small catalog of allowed events and a unique `event_id`. Duplicate delivery returns success without a duplicate row.

## 4. Normal answer flow

```text
1. User selects an answer.
2. Frontend updates the local answer object.
3. Frontend queues a progress save.
4. Backend authorizes the session.
5. Backend checks expected revision.
6. Backend validates all submitted answers against quiz_variant and rejects accidental key removal.
7. Backend updates sessions.quiz_answers and current_step_id.
8. Backend increments sessions.revision.
9. Backend inserts the milestone event when requested.
10. Backend commits and returns the new revision.
```

The frontend should serialize saves per session. Navigation may remain responsive, but the save queue must preserve order.

## 5. Transaction rules

Use one transaction when two facts must agree. Examples:

- persisted step state and its `step_completed` event;
- final result, completed status, completion timestamp, and `quiz_completed` event;
- authenticated user link and any server-owned link event.

Product analytics calls and email-provider calls do not belong inside the database transaction. They may be triggered after commit and retried independently.

## 6. Error model

Stable error codes are part of the API contract:

| Status | Code                         | Meaning                                          |
| -----: | ---------------------------- | ------------------------------------------------ |
|    400 | `INVALID_REQUEST`            | Malformed JSON or missing required field         |
|    401 | `UNAUTHORIZED_SESSION`       | Missing or invalid session credential            |
|    403 | `SESSION_OWNERSHIP_MISMATCH` | Authenticated caller does not own the session    |
|    404 | `SESSION_NOT_FOUND`          | No accessible session exists                     |
|    409 | `STALE_SESSION_REVISION`     | Newer quiz progress was already saved            |
|    409 | `SESSION_ALREADY_COMPLETED`  | Normal writes are not allowed after completion   |
|    422 | `INVALID_QUIZ_ANSWERS`       | Saved answers do not match their definition      |
|    413 | `PAYLOAD_TOO_LARGE`          | A configured JSON or metadata limit was exceeded |
|    500 | `PERSISTENCE_FAILED`         | Unexpected storage failure                       |

Logs may include request IDs, session IDs, revisions, route names, and error codes. They must not include full answer objects, raw tokens, email addresses, payment data, or consent payloads.
