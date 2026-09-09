# Quiz Backend Documentation

This package documents the reusable backend for the funnel quiz. It is intentionally based on the boilerplate's existing snapshot model: one database row per quiz session, not one row per answer.

## Final architecture decision

The quiz backend owns two database tables:

1. `public.sessions` stores the current state of one quiz journey, including all current answers and the final result.
2. `public.funnel_events` stores append-only milestone history for that journey.

Do not add separate `quiz_responses`, `quiz_results`, or `funnel_inputs` tables for the standard boilerplate. The JSONB snapshot on `sessions` is deliberate: quiz structures change between products, while the table shape remains stable.

## How data moves

```text
Quiz frontend
  -> backend session API
  -> validation, authorization and scoring service
  -> sessions row (current truth)
  -> funnel_events rows (history only)
```

When a visitor answers a question, the frontend updates its local answer object and sends the complete current snapshot. The backend validates it and updates the same `sessions` row. A milestone event may be inserted separately, but no answer row is created.

## Required reading order

1. [Backend structure](BACKEND_STRUCTURE.md)
2. [Data model](DATA_MODEL.md)
3. [API contract](API_CONTRACT.md)
4. [Event catalog](EVENT_CATALOG.md)
5. [Implementation status](IMPLEMENTATION_STATUS.md)
6. [Realistic failure modes](KNOWN_RISKS.md)
7. [Acceptance checklist](ACCEPTANCE_CHECKLIST.md)
8. [Reference schema](reference-schema.sql)

AI coding agents must also follow the repository's root `AGENTS.md` and `CLAUDE.md`.

## Scope

This module owns:

- session creation and resume;
- progressive saving of the full current answer snapshot;
- current-step progress;
- captured email and consent state used by the funnel;
- versioned quiz validation;
- server-side completion and result calculation;
- anonymous-to-authenticated user linking;
- durable funnel milestones.

It does not own:

- frontend question rendering;
- payment-provider behavior;
- subscriptions and entitlements;
- email delivery infrastructure;
- raw product analytics;
- deployment.

## Documentation status

The hardened backend is implemented on `quiz-branch-`, while frontend integration is deliberately deferred. See `IMPLEMENTATION_STATUS.md` for the exact boundary. `reference-schema.sql` remains explanatory; the implemented schema lives in `supabase/migrations/00001_baseline.sql`.
