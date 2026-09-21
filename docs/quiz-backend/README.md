# Quiz Backend Documentation

This package documents the reusable backend for the funnel quiz. It uses one database row per quiz session, not one row per answer.

## Final architecture decision

The quiz backend owns two database tables:

1. `public.sessions` stores the current state of one quiz journey, including all current answers and the final result.
2. `public.funnel_events` stores append-only milestone history for that journey.

CRO step tracking adds one column (`sessions.step_activity`) and a small read-only catalog describing the quiz's own structure — no user data and no per-answer rows. See [CRO_TRACKING.md](CRO_TRACKING.md).

Do not add separate `quiz_responses`, `quiz_results`, or `funnel_inputs` tables for the standard boilerplate. The complete JSONB answer object on `sessions` is deliberate: quiz structures change between products, while the table shape remains stable.

## How data moves

```text
Quiz frontend
  -> backend session API
  -> validation, authorization and scoring service
  -> sessions row (current truth)
  -> funnel_events rows (history only)
```

When a visitor answers a question, the frontend updates its local answer object and sends the complete current answers. The backend validates them and updates the same `sessions` row. A milestone event may be inserted separately, but no answer row is created.

“Save” always means updating the existing session row. It does not create a screenshot, a second session, or an answer row.

## Required reading order

1. [Human handoff in Lithuanian](HANDOFF.lt.md)
2. [Backend structure](BACKEND_STRUCTURE.md)
3. [Data model](DATA_MODEL.md)
4. [API contract](API_CONTRACT.md)
5. [Event catalog](EVENT_CATALOG.md)
6. [Meta tracking contract](META_TRACKING.md)
7. [Implementation status](IMPLEMENTATION_STATUS.md)
8. [Realistic failure modes](KNOWN_RISKS.md)
9. [Acceptance checklist](ACCEPTANCE_CHECKLIST.md)
10. [Reference schema](reference-schema.sql)

AI coding agents must also follow the repository's root `AGENTS.md` and `CLAUDE.md`.

## Scope

This module owns:

- session creation and resume;
- progressive saving of the complete current answer object;
- current-step progress;
- captured email and consent state used by the funnel;
- versioned quiz validation;
- server-side completion and result calculation;
- anonymous-to-authenticated user linking;
- durable funnel milestones.
- safe Meta Pixel/CAPI quiz and conversion event integration.

It does not own:

- frontend question rendering;
- payment-provider behavior;
- subscriptions and entitlements;
- email delivery infrastructure;
- raw product analytics;
- deployment.

The reference implementation creates a session as soon as the Quiz screen becomes active. This deliberately preserves visitors who leave before their first click as measurable first-screen drop-off. The create API excludes only known Meta crawler User-Agent tokens before any session or event write; Facebook and Instagram in-app browsers used by real visitors are not excluded.

## Documentation status

The hardened backend and the main quiz-screen integration are implemented on `quiz-branch-`. See `IMPLEMENTATION_STATUS.md` for the exact boundary and the legacy non-quiz callers that still use the compatibility route. `reference-schema.sql` remains explanatory; the implemented schema lives in `supabase/migrations/00001_baseline.sql`.
