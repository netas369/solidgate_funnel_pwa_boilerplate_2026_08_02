# Quiz Backend Acceptance Checklist

The hardened quiz backend is complete only when every required item below is tested. The current gap list lives in `IMPLEMENTATION_STATUS.md`.

## Two-table model

- [ ] One quiz journey creates exactly one `sessions` row.
- [ ] Answering or changing ten questions still leaves exactly one session row.
- [ ] All current answers are stored in `sessions.quiz_answers`.
- [ ] Final result is stored in `sessions.quiz_result` with `result_segment`.
- [ ] Only milestone history is stored in `funnel_events`.
- [ ] No `quiz_responses`, `quiz_results`, or `funnel_inputs` table is introduced for standard quiz persistence.

## Authorization and privacy

- [ ] A session UUID without a valid credential cannot read or update an anonymous session.
- [ ] Authenticated users can access only sessions they own.
- [ ] User linking derives the user from trusted authentication context.
- [ ] A session cannot be reassigned to a different user.
- [ ] Logs and event metadata exclude full answers, email, tokens, IP addresses, and payment data.
- [ ] Email-only answer recovery is disabled.

## Snapshot persistence

- [ ] Full snapshots validate against the immutable `quiz_variant`.
- [ ] Unknown question keys, invalid option codes, wrong types, and oversized JSON are rejected.
- [ ] Valid progress updates the existing row and increments `revision` once.
- [ ] A stale revision returns `409` without overwriting newer data.
- [ ] Concurrent and deliberately reordered requests cannot lose the newest snapshot.
- [ ] Empty or partially hydrated client state cannot wipe valid answers unexpectedly.
- [ ] Failed mobile/offline saves are queued and retried.
- [ ] Final lead/completion saves are awaited before navigation.

## Session lifecycle

- [ ] `quiz_variant`, `funnel_variant`, first-touch attribution, and original source remain immutable.
- [ ] Only active sessions accept normal progress saves.
- [ ] Completion validates all required reachable answers.
- [ ] Completion computes the result on the server.
- [ ] Result, status, completion timestamp, revision, and `quiz_completed` event commit atomically.
- [ ] Retrying completion returns the stored result and creates no duplicate event.

## Events

- [ ] Every event has a unique `event_id`.
- [ ] Retrying the same `event_id` does not create another row.
- [ ] Unknown and server-owned event types are rejected from public clients.
- [ ] Required step events are committed with the matching session update.
- [ ] Refreshing or navigating backward/forward does not inflate one-time funnel milestones.
- [ ] Event metadata size limits and sensitive-data rules are enforced.

## Versioning and documentation

- [ ] Persisted quiz definitions are immutable.
- [ ] Behavioral changes create a new `quiz_variant`.
- [ ] API examples pass contract tests.
- [ ] Runtime event allowlist matches `EVENT_CATALOG.md` and database checks.
- [ ] Applied migrations are reflected in `packages/shared/src/types/database.ts`.
- [ ] `IMPLEMENTATION_STATUS.md` accurately distinguishes completed and proposed behavior.
- [ ] No deployment or remote migration is performed without explicit authorization.
