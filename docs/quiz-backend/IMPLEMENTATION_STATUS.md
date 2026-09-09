# Implementation Status

This file separates implemented backend behavior from frontend integration that is deliberately deferred.

## Implemented on `quiz-branch-`

### Database

- The existing two-table model remains: `public.sessions` and `public.funnel_events`.
- `sessions` now includes `visitor_id`, `quiz_result`, `status`, `revision`, `quiz_variant`, `funnel_variant`, `attribution`, `client_context`, and `completed_at`.
- `funnel_events` now includes unique `event_id` and `occurred_at`.
- Unique milestone indexes prevent duplicate `quiz_started`, `lead_captured`, `quiz_completed`, and per-step `step_completed` rows.
- `create_quiz_session` creates a session and `quiz_started` atomically.
- `persist_quiz_session_snapshot` updates the same session row, enforces optimistic revision, and writes an optional milestone atomically.
- `complete_quiz_session` saves the result on the same row and emits `quiz_completed` atomically and idempotently.
- `record_funnel_event` provides retry-safe event insertion.
- `link_quiz_session_user` prevents ownership reassignment.
- Generated TypeScript database types include the new columns and RPC signatures.

### Backend API

- `POST /api/session/create` creates a versioned session and sets a signed, HTTP-only session cookie.
- `POST /api/session/snapshot` validates a full answer snapshot and saves it with `expectedRevision`.
- `GET /api/session/read` accepts authenticated ownership, the quiz-session cookie, or the existing verified payment cookie.
- `POST /api/session/complete` validates required reachable answers and computes the result on the server.
- `POST /api/session/link-user` links only to the authenticated principal.
- `POST /api/funnel-events` validates client-allowed event names, ownership, metadata, event IDs, and bounded occurrence times; payment-confirmed events are server-only.
- Quiz answers are validated against the current immutable `boilerplate-v1` definition.
- Request limits and stable error codes are implemented.

### Tests

- Route tests cover create, snapshot, completion, event rejection, authorization, invalid answers, and stale revisions.
- Unit tests cover versioned answer validation and signed-cookie tamper resistance.
- `supabase/tests/quiz_backend.sql` covers one-row snapshots, atomic events, stale revisions, event idempotency, and immutable completion.

## Deliberately not changed: frontend integration

The user requested backend-only work. Therefore the current quiz frontend still uses its legacy behavior:

- It creates and updates sessions through `POST /api/session/persist`.
- It does not yet store or send `revision`.
- It does not yet use `POST /api/session/create`, `/api/session/snapshot`, or `/api/session/complete`.
- It still inserts some funnel events directly from the browser.
- It does not yet serialize progress saves or retry the latest failed normal snapshot.

The legacy `/api/session/persist` route and temporary direct-event RLS policies remain so this backend commit does not break the existing frontend. The legacy special-offer path also retains email-based answer hydration. Do not describe those legacy paths as hardened.

## Required frontend follow-up

When frontend work is explicitly authorized:

1. Add `revision` to the persisted quiz store.
2. Create sessions through `/api/session/create`.
3. Serialize progress saves through `/api/session/snapshot`.
4. Include step and lead events in the snapshot transaction.
5. Complete through `/api/session/complete` before navigating to the offer.
6. Send remaining allowed events through `/api/funnel-events`.
7. Remove direct browser database inserts and their RLS policies.
8. Remove the legacy `/api/session/persist` path and email-only hydration after all callers migrate.

## Product customization still required

- Replace the neutral `boilerplate-v1` scoring function with product rules.
- Create a new immutable quiz variant whenever question meaning, branching, or scoring changes.
- Decide retention and deletion periods with the product/privacy owner.

## Verification note

TypeScript compilation and backend-focused Vitest suites pass. The SQL behavior test is committed but was not executed locally because the Docker daemon/Postgres server was unavailable; run it with the disposable database instructions in `supabase/tests/README.md` before merging or deployment.
