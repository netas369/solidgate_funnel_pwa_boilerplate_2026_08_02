# Implementation Status

This file prevents the design document from being mistaken for completed runtime behavior.

## Already implemented in this repository

- `public.sessions` stores one row per journey.
- `sessions.quiz_answers` stores the complete answer snapshot as JSONB.
- Normal quiz persistence updates the same session row instead of inserting one row per answer.
- `sessions.current_step_id`, `email`, `locale`, consent fields, `result_segment`, `source`, and timestamps exist.
- `public.funnel_events` is separate from current session state.
- The frontend sends its complete current answer object to `POST /api/session/persist` on step advance.
- Lead capture is awaited and retried once; failed lead payloads are queued in browser storage.
- Session reads require authenticated ownership or a verified payment cookie.

Relevant current files:

- `supabase/migrations/00001_baseline.sql`
- `apps/funnel/src/app/api/session/persist/route.ts`
- `apps/funnel/src/app/api/session/read/route.ts`
- `apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts`
- `apps/funnel/src/features/quiz/hooks/use-quiz-navigation.ts`
- `apps/funnel/src/features/quiz/lib/track-funnel-event.ts`
- `apps/funnel/src/stores/quiz-store.ts`

## Not yet implemented from the hardened contract

- `sessions.revision` and optimistic-concurrency enforcement.
- A per-session serialized save queue for normal progress snapshots.
- Server validation of the full snapshot against an immutable `quiz_variant`.
- Dedicated `sessions.quiz_result`, `sessions.status`, and `sessions.completed_at` fields.
- Server-owned deterministic completion/scoring endpoint.
- `funnel_events.event_id` uniqueness for retry-safe events.
- Atomic session update and milestone-event insert.
- Atomic insert/upsert that removes the current check-then-insert race.
- Signed anonymous session authorization for normal quiz persistence and reads.
- A safe recovery flow that does not restore old answers based only on matching email.
- Bounded JSON payload enforcement.

## Current behavior that must be treated carefully

1. Normal step saves are fire-and-forget and can be lost if the browser closes or the connection fails.
2. Concurrent full snapshots can arrive out of order, allowing an older snapshot to replace a newer one.
3. The persist route replaces `quiz_answers`; it does not merge individual answer keys.
4. Step-event deduplication uses an in-memory set that resets on refresh.
5. Session updates and event inserts are separate operations.
6. Special-offer hydration copies answers from the latest session matching an email address. Email alone does not prove ownership.
7. The public browser currently inserts funnel events directly under permissive RLS policies.

## Implementation sequence

When the team chooses to implement hardening, use this order:

1. Add schema fields and generated database types.
2. Add authorization and versioned answer-validation utilities.
3. Implement atomic create/upsert with revision checks.
4. Add event idempotency and transactional milestone writes.
5. Add server completion/scoring.
6. Add the frontend save queue and conflict handling.
7. Replace email-only recovery with a signed recovery mechanism.
8. Run the full checklist and update this file.

Do not mark an item implemented because it exists only in documentation or `reference-schema.sql`.
