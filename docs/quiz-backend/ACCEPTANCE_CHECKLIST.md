# Quiz Backend Acceptance Checklist

The hardened quiz backend is complete only when every required item below is tested. `[x]` means the current local application suite or a direct code check provides evidence. `[ ]` means it still needs a disposable PostgreSQL/browser run or a future product-owner decision. The current gap list lives in `IMPLEMENTATION_STATUS.md`.

## Two-table model

- [x] One quiz journey creates exactly one `sessions` row.
- [x] Answering or changing ten questions still leaves exactly one session row.
- [x] All current answers are sent as one object to `sessions.quiz_answers`.
- [x] Final result is stored in `sessions.quiz_result` with `result_segment`.
- [x] Quiz application code sends only milestone history to `funnel_events`.
- [x] No `quiz_responses`, `quiz_results`, or `funnel_inputs` table is introduced for standard quiz persistence.

## Authorization and privacy

- [x] A session UUID without a valid credential cannot read or update an anonymous session.
- [x] Authenticated users can access only sessions they own.
- [x] User linking derives the user from trusted authentication context.
- [x] The API returns a conflict when the database refuses ownership reassignment.
- [ ] Logs and event metadata exclude full answers, email, tokens, IP addresses, and payment data.
- [x] Email-only answer recovery is disabled.

## Progress saving

- [x] Complete answer objects validate against the session's supported `quiz_variant`.
- [x] Unknown question keys, invalid option codes, wrong types, and oversized JSON are rejected.
- [x] Valid progress updates the existing row and increments `revision` once.
- [x] A stale revision is rejected without overwriting newer data; the API translates it to `409`.
- [x] In-page concurrent requests are serialized and stale responses are reconciled once.
- [x] Empty or partially hydrated client state cannot wipe valid answers unexpectedly.
- [x] Failed in-page saves remain serialized; the latest local progress is retried on the next save or resume.
- [x] Final lead/completion saves are awaited before navigation.

## Session lifecycle

- [x] A normal Quiz screen load creates a session before any click, preserving zero-interaction drop-off.
- [x] Known Meta crawler User-Agents create no session, cookie, or `quiz_started` event.
- [x] Facebook and Instagram in-app browsers remain treated as real visitors.
- [ ] `quiz_variant`, `funnel_variant`, first-touch attribution, and original source remain immutable.
- [x] Only active sessions accept normal progress saves at the API boundary.
- [x] Completion validates all required reachable answers.
- [x] Completion computes the result on the server.
- [x] Result, status, completion timestamp, revision, and `quiz_completed` event commit atomically.
- [x] Retrying completion returns the stored result and creates no duplicate event.

## Events

- [x] Every event has a unique `event_id`.
- [x] Retrying the same `event_id` does not create another row.
- [x] Unknown and server-owned event types are rejected from public clients.
- [x] Required step events are committed with the matching session update.
- [ ] Refreshing or navigating backward/forward does not inflate one-time funnel milestones.
- [ ] Event metadata limits and sensitive-key rules are enforced by validated APIs; sign-off waits for legacy direct-insert policies to be removed by the downstream owners.

## Versioning and documentation

- [ ] Persisted quiz definitions are immutable.
- [ ] Behavioral changes create a new `quiz_variant`.
- [ ] API examples pass contract tests.
- [x] Runtime event allowlist matches `EVENT_CATALOG.md` and database checks.
- [x] Local migration changes are reflected in `packages/shared/src/types/database.ts`.
- [x] `IMPLEMENTATION_STATUS.md` accurately distinguishes completed and proposed behavior.
- [x] No deployment or remote migration was performed.

## Local evidence

- Funnel suite: 95 files and 1,038 tests passed.
- Shared package: 29 files and 342 tests passed.
- Funnel TypeScript check passed.
- Changed TypeScript/TSX files have zero ESLint errors or file-level warnings.
- Next.js production build passed and lists all five `/api/quiz/session/*` routes.
- The full baseline migration applied successfully to isolated local Supabase.
- `supabase/tests/quiz_backend.sql` passed and rolled back its test data. It covers one-row persistence across ten saves, revision conflicts, event idempotency, and idempotent completion.
