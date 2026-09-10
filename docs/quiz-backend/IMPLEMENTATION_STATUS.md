# Quiz Implementation Status

This file separates the Quiz module from compatibility behavior owned by other funnel modules. The Quiz implementation is maintained on `quiz-branch-`; it is not merged into `main` or deployed by this documentation.

## Implemented Quiz module

### Database

- The two-table model remains: `public.sessions` and `public.funnel_events`.
- One quiz journey creates one `sessions` row. Every answer save updates `sessions.quiz_answers` on that row.
- The final server-calculated result is stored in `sessions.quiz_result` and `sessions.result_segment`.
- `funnel_events` contains durable milestones rather than one row per answer.
- `create_quiz_session` creates the session and `quiz_started` together.
- `save_quiz_session_progress` updates the same session row, enforces the expected revision, and can write `step_completed` or `lead_captured` in the same transaction.
- `complete_quiz_session` stores the result and emits `quiz_completed` atomically and idempotently.
- `record_funnel_event` provides retry-safe milestone insertion.
- `link_quiz_session_user` prevents ownership reassignment.

### Quiz-owned API namespace

- `POST /api/quiz/session/create` creates a versioned session and sets a signed, HTTP-only Quiz cookie.
- `GET /api/quiz/session/read` returns authorized resumable Quiz fields only.
- `POST /api/quiz/session/save` validates and saves the complete current answer object.
- `POST /api/quiz/session/complete` validates required reachable answers and calculates the result on the server.
- `POST /api/quiz/session/link-user` links only to the authenticated principal.
- `POST /api/funnel-events` remains the shared downstream milestone endpoint until the Funnel/Payment/OTO owners complete their event integration.

### Module isolation

- Quiz authorization accepts an authenticated Quiz owner or the signed Quiz session cookie. It does not accept a Payment cookie.
- Quiz session creation does not inspect Payment environment, entitlements, orders, or Solidgate catalog data.
- Quiz session reads do not append Payment subscription details.
- Quiz cookie signing uses the independent `QUIZ_SESSION_COOKIE_SECRET`; it does not use `PAYMENT_COOKIE_SECRET`.
- Quiz lead capture records email, consent, and `welcome_email_pending` in the database. It does not call ActiveCampaign or another email provider directly.

### Existing Quiz screens

- Fresh journeys call the Quiz create endpoint when the screen becomes active, before accepting progress or requiring a click. This preserves genuine zero-interaction drop-off.
- The create endpoint filters known Meta crawler User-Agent tokens before signing a cookie or calling the database, so they create no session or `quiz_started` event.
- Facebook and Instagram in-app browsers are explicitly allowed; `fbclid`, Meta referrers, `FBAN`, `FBAV`, and `Instagram` are not treated as bot evidence.
- A filtered crawler receives an empty `204` response and the client renders the public first screen without keeping the temporary session ID or emitting Quiz analytics.
- The persisted Zustand store keeps the server revision and a local `hasUnsavedProgress` marker.
- Persisted browser recovery data expires after seven days, and failed lead capture no longer creates a second permanent email-and-answers cache.
- Existing journeys resume through the authorized Quiz read endpoint.
- Forward progress sends the complete answer object to the Quiz save endpoint.
- Saves are serialized per session and use the latest returned revision.
- A stale revision triggers one authorized read, merges unsaved local values over stored values, and retries once.
- `step_completed` and `lead_captured` are committed with their matching session update.
- If both lead-save attempts fail, the email screen remains open with a retry message.
- The terminal screen waits for the final save and server completion before navigating to the offer.
- Server completion is the only source of the trusted result and `quiz_completed` milestone.
- Locally unsaved progress is reconciled during resume.

## Compatibility behavior outside Quiz ownership

- `/api/session/persist` remains because Special Offer and Checkout flows still use it. New Quiz-screen code must not use it.
- Post-quiz Offer/OTO/Checkout analytics still contains a legacy direct `funnel_events` browser insert. Removing its database policy before those owners migrate would silently lose downstream conversion events.
- `checkout_completed` must ultimately be written by a trusted Payment backend after provider confirmation. The Quiz browser must not claim that a payment completed.
- Payment, OTO, PWA, Support, Admin, the CPO/CRO API Gate, and PMC Hub behavior are not implemented or changed by the Quiz module.

## Boilerplate customization still required

- Replace the neutral `boilerplate-v1` questions and scoring with the new product's versioned definition.
- Create a new immutable `quiz_variant` whenever question meaning, branching, or scoring changes.
- The product/privacy owner must decide retention and deletion periods.
- The email owner must process `welcome_email_pending` and clear it only after a successful provider handoff.

## Verification status

Local verification completed on 2026-09-11:

- Funnel Vitest suite: 95 files, 1,038 tests passed.
- Shared-package Vitest suite: 29 files, 342 tests passed.
- Funnel TypeScript check passed.
- Changed TypeScript/TSX files have zero ESLint errors or file-level warnings.
- Next.js production build passed and exposed all five `/api/quiz/session/*` routes.
- The full baseline migration applied successfully to isolated local Supabase.
- `supabase/tests/quiz_backend.sql` passed, including ten saves into one session row, stale-write protection, event idempotency, and idempotent completion; its transaction rolled back all test data.
- `git diff --check` passed.

A browser smoke test through the running application remains the final optional end-to-end check. No remote database, deployment, commit, merge, or push was performed.
