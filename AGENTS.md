# Repository instructions for AI coding agents

Read `CLAUDE.md` first. It contains the repository-wide architecture, safety rules, and testing commands.

## Quiz backend rules

Before changing quiz persistence, read `docs/quiz-backend/README.md` and every document it marks as required.

- The quiz backend uses exactly two persistence tables: `public.sessions` and `public.funnel_events`.
- `public.sessions` is the single source of truth for current quiz state. One session is one row. Save the complete current answer object in `sessions.quiz_answers`; never create a row for each answer.
- Store the final server-computed result on the same session row. Do not introduce `quiz_responses`, `quiz_results`, or `funnel_inputs` tables unless a future requirement is documented and explicitly approved.
- `public.funnel_events` is append-only milestone history. It is not the current state and must not contain full answer objects, email addresses, tokens, payment data, or unrestricted clickstream data.
- Version every quiz definition. Existing question keys, answer meanings, branching, and scoring remain immutable for sessions using that version.
- The client may submit answers and progress, but the backend owns authorization, validation, revision checks, timestamps, completion, and scoring.
- An anonymous session ID is not authorization. Use a signed session credential or authenticated ownership for reads and writes.
- Do not deploy, link a cloud database, apply remote migrations, or change production data unless the user explicitly authorizes it.
- Treat `docs/quiz-backend/reference-schema.sql` as documentation, not as an automatically applied migration.
- If runtime behavior differs from the documentation, describe the difference in `docs/quiz-backend/IMPLEMENTATION_STATUS.md`; never hide the mismatch.

## Required checks for quiz persistence changes

1. Run the affected route, store, and quiz tests.
2. Confirm that answering multiple questions still updates one `sessions` row.
3. Test retries, stale revisions, out-of-order requests, resume, completion idempotency, and event idempotency.
4. Regenerate `packages/shared/src/types/database.ts` after an applied database migration.
5. Update the API contract, event catalog, implementation status, and acceptance checklist in the same commit when their behavior changes.
