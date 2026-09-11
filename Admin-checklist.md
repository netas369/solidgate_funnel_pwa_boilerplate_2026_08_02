# Admin / Support Project-Creation Checklist

Use this checklist when adapting the boilerplate's `/admin` dashboard and support
console for a new project. Work from top to bottom: later sections assume that the
project identity, data sources, and access rules have already been decided.

The default implementation is project-neutral:

- `/admin/login` — allowlisted staff authentication with Supabase OTP.
- `/admin/dashboard` — internal funnel, revenue, subscription, customer, and offer analytics.
- `/admin/support` — exact-email customer evidence plus tightly guarded support actions.
- `/admin/audit` — administrator-only support-action evidence.
- `/admin/health` — administrator-only configuration and dependency readiness.

The diagram supplied with this task is architecture context, not an instruction to
connect a production system. The central reporting hub/API gateway section below is
therefore conditional until its owner, contract, and credentials are confirmed.

## How to use this file

Copy this file into each new project, fill in the project record, and attach evidence to
completed items (PR, migration, screenshot, query, test run, or deployment URL).

Status convention:

- `[ ]` not checked or incomplete
- `[x]` complete with evidence
- `N/A — reason` deliberately not required for this project
- `Blocked — owner/date` cannot proceed without a named dependency

This checklist does **not** authorize a production deploy, database migration, secret
rotation, customer communication, refund, cancellation, entitlement change, or any
other support mutation. Obtain the normal approval for those actions.

## 0. Project record and ownership

| Field | Value |
|---|---|
| Project name | |
| Repository / branch | |
| Technical owner | |
| Support owner | |
| Security / privacy reviewer | |
| Staging admin URL | |
| Production admin URL | |
| Primary database project | |
| Payment providers and account/environment names | |
| Permanent analytics project key | |
| Central hub/API gateway project ID, if applicable | |
| Approved support actions | |
| Target launch date | |

- [ ] Confirm who can approve admin access and who removes access when a staff member leaves.
- [ ] Confirm who owns support data correctness, payment reconciliation, and action runbooks.
- [ ] Define the staging and production sign-off owners.
- [ ] Record every external dependency that can make a report partial rather than complete.
- [ ] Decide the retention period for support audit records and operational evidence.

**Exit criterion:** every security-sensitive decision has a named owner; no required field
is being inferred from another project.

## 1. Scope the admin surface

- [ ] List the admin modules needed for this project. Start with `Dashboard` and `Support`;
  add product-specific modules only when they have an owner and a real data source.
- [ ] Confirm the canonical routes: `/admin/login`, `/admin/dashboard`, `/admin/support`,
  `/admin/audit`, and `/admin/health`; disable optional modules in `admin.config.ts`.
- [ ] Confirm whether the admin is intentionally outside the locale tree.
- [ ] Define staff roles: administrator, support operator, read-only tester, or other.
- [ ] Write an authorization matrix showing which role may view each module and run each action.
- [ ] Choose the access model before implementation:
  - Default: the integrated `/admin/support` route uses the same allowlisted Supabase OTP
    session as the rest of `/admin`.
  - Optional: a separate secret-link, read-only tester console is allowed only when the
    business explicitly needs it and all controls in section 5 are implemented.
- [ ] Decide which dashboard metrics are required at launch and mark the others `N/A`.
- [ ] Decide which support actions are allowed at launch. The safe default is only
  `send_login_code` and `revoke_sessions`.
- [ ] Explicitly decide whether refunds, cancellations, complimentary access, credits,
  lesson unlocks, or manual entitlements are excluded. Do not inherit them from a reference project.
- [ ] Define the project's sources of truth for identity, payments, subscriptions, and access.

**Exit criterion:** the routes, roles, metrics, data sources, and allowed actions are written
down before product-specific code is added.

## 2. Keep the boilerplate brand neutral

- [ ] Set the neutral default label and internal app path in
  `apps/funnel/src/admin.config.ts`; use `ADMIN_PROJECT_LABEL` and `ADMIN_APP_PATH` only
  for environment-specific overrides.
- [ ] Keep shared navigation labels generic: `Dashboard`, `Support`, `Open app`, and `Sign out`.
- [ ] Put product vocabulary, product codes, display labels, and feature names in a project
  adapter or configuration module rather than shared UI components.
- [ ] Remove reference-project names, domains, emails, logos, colors, price IDs, product IDs,
  statement descriptors, provider account IDs, demo addresses, and test customer IDs.
- [ ] Search source, tests, fixtures, documentation, and environment examples for copied brands.
- [ ] Verify page titles, empty states, errors, email copy, downloaded filenames, and JSON
  exports do not expose a reference brand.
- [ ] Confirm the shell remains usable when optional product adapters are absent.

Suggested check:

```bash
rg -n -i 'reference-brand|reference-domain|reference-product' apps packages docs .env.example
```

**Exit criterion:** a new project can change its label, app destination, and data adapters
without forking the shared admin shell.

## 3. Environment and secret configuration

- [ ] Add `ADMIN_ACCESS=email:role,email:role` in local, preview/staging, and production.
  Supported roles are `administrator`, `support`, `analyst`, and `viewer`.
- [ ] Use legacy `ADMIN_EMAILS` only during migration; it grants administrator capability
  and is ignored whenever `ADMIN_ACCESS` is present.
- [ ] Normalize access entries by trimming and lowercasing; require exact email matches and
  fail closed on invalid or conflicting entries.
- [ ] Use separate allowlists for non-production and production where possible.
- [ ] Add `ADMIN_PROJECT_LABEL` and `ADMIN_APP_PATH` in every deployed environment.
- [ ] Set `ADMIN_PAYMENT_ENVIRONMENT` and verify it names the exact ledger environment the
  analytics adapter may read.
- [ ] Add and validate the Supabase URL, public key, and server-only service-role key needed by
  the admin's server data layer.
- [ ] Add server-only credentials for each optional live provider adapter and label its exact
  account and environment (`test`, `sandbox`, or `live`).
- [ ] Add the email provider/sender configuration needed for OTP or access-email actions.
- [ ] Set `ADMIN_FX_RATES` for every non-EUR payment currency used by dashboard revenue and
  customer-LTV calculations; reconcile each rate and document when it is refreshed.
- [ ] Set one permanent lowercase `ANALYTICS_PROJECT_KEY` consistently in funnel, PWA, and
  payment-webhook environments.
- [ ] If central export is enabled, configure its base URL, project ID, schema version, and a
  narrowly scoped server-to-server credential.
- [ ] Keep service-role keys, provider secrets, admin credentials, and gateway credentials out
  of `NEXT_PUBLIC_*`, browser bundles, logs, URLs, analytics properties, and committed files.
- [ ] Configure `apps/funnel/src/admin.config.ts`: enabled modules, registered adapter IDs,
  OTP request limit, payment environment, reporting currency, trial maturity, main product
  codes, recurring offers, enabled support actions, source caps, and support rate limits.
- [ ] Run `npm run admin:verify` in every configured environment; invalid manifests, access
  policies, adapters, FX syntax, generated types, or required files must fail closed.
- [ ] Document secret owners, rotation procedure, and emergency revocation procedure.

**Exit criterion:** secrets are server-only, environment-specific, validated, and owned.

## 4. Database and migrations

- [ ] Review and apply the admin support migration after the project baseline; in this
  boilerplate that is `supabase/migrations/00002_admin_support.sql`.
- [ ] Review and apply `supabase/migrations/00003_admin_metrics.sql` and the V2 correctness,
  rate-limit, and idempotency migration `supabase/migrations/00004_admin_core.sql`.
- [ ] Confirm the action-audit table is durable and available before enabling mutations.
- [ ] Keep audit rows append-only to ordinary staff workflows.
- [ ] Store an email digest in audit/rate-limit records when the plain address is not required.
- [ ] Include actor ID, action type, target digest, idempotency key, status, safe details,
  creation time, and completion time in the audit model.
- [ ] Enable RLS and revoke `anon`/`authenticated` access from internal evidence and audit tables;
  grant only the minimum server role required.
- [ ] Add exact-lookup indexes and bounded RPCs where the auth schema cannot be queried safely.
- [ ] Ensure database functions set a safe `search_path` and have the smallest possible grants.
- [ ] Add project-specific tables as new migrations; do not rewrite an already-deployed baseline.
- [ ] Make migrations safe to apply once and document rollback or forward-repair steps.
- [ ] Regenerate shared database types after the schema is applied.
- [ ] Test the migration against a fresh database and an upgrade-shaped database.
- [ ] Verify production actions fail closed if their audit migration is absent. A structured log
  is not a sufficient replacement for a required durable audit row.

```bash
npx supabase gen types typescript --linked > packages/shared/src/types/database.ts
```

**Exit criterion:** the deployed schema, generated types, RLS, and application queries agree.

## 5. Authentication and route security

### Required for the integrated `/admin` model

- [ ] Protect every `/admin/*` page except `/admin/login` with a server-side session and the
  capability resolved from `ADMIN_ACCESS` (or the legacy `ADMIN_EMAILS` fallback).
- [ ] Protect every `/api/admin/*` handler independently. Middleware/page protection alone is
  never authorization for an API.
- [ ] Return `401` for unauthenticated API calls and `403` for an authenticated but unauthorized
  user where revealing the route is acceptable; keep behavior consistent and tested.
- [ ] Make OTP request responses generic so callers cannot enumerate the allowlist.
- [ ] Use `shouldCreateUser: false` for a login-code action unless account creation is an
  explicitly approved workflow.
- [ ] Validate login destinations as local paths; reject open redirects.
- [ ] Rate-limit login attempts, support lookups, and support actions before expensive work.
- [ ] Keep support lookup/action limits atomic and database-backed; missing rate-limit storage
  must deny the protected request rather than allow it.
- [ ] Re-authorize the administrator inside every mutation immediately before changing state.
- [ ] Prevent an administrator from revoking their own current session through the support UI.
- [ ] Implement sign-out and verify a signed-out session cannot use a previously opened API tab.
- [ ] Keep admin pages dynamic and uncached; send `Cache-Control: private, no-store`.
- [ ] Send `X-Robots-Tag: noindex, nofollow, noarchive` and `Referrer-Policy: no-referrer` on
  admin/support pages and APIs.
- [ ] Exclude `/admin/*` and `/support/*` from analytics, pixels, attribution capture, error
  replay, and session recording.
- [ ] For mutation APIs, require same-origin JSON, reject cross-site `Sec-Fetch-Site`, validate
  `Origin`, cap body size before parsing, and accept only a JSON object.

### Only if a separate secret-link tester console is approved

- [ ] Generate at least 256 bits of random entropy and keep the support key server-only.
- [ ] Validate the key server-side using constant-time comparison; missing, weak, invalid, or
  unconfigured keys must fail closed with an ordinary `404`.
- [ ] Prefer exchanging the URL key for a short-lived signed `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie, then redirect to a keyless URL.
- [ ] Keep the route outside layouts that load third-party scripts and ensure the key cannot
  appear in referrers, telemetry, screenshots, or copied support exports.
- [ ] Make the link read-only. Require the normal administrator session in addition to the link
  session for every mutation.
- [ ] Support key rotation with a documented overlap window and immediate revocation path.

**Exit criterion:** direct page, API, stale-session, cross-site, and malformed-body attempts all
fail safely; no browser-visible secret grants mutation access by itself.

## 6. Admin shell and dashboard

- [ ] Verify the shared shell renders the configured project label without a logo or product palette.
- [ ] Verify the `Support` tab is present in desktop and mobile navigation and resolves to
  `/admin/support` without passing customer data in the URL.
- [ ] Verify desktop and mobile navigation, active states, keyboard focus, and sign-out.
- [ ] Verify `Open app` resolves only to an approved internal destination.
- [ ] Verify module flags remove disabled pages and navigation without becoming an
  authorization substitute.
- [ ] Verify role navigation and landing routes match the capability matrix: administrator,
  support, analyst, and viewer.
- [ ] Decide and document the dashboard timezone and date-range convention. Prefer inclusive
  start and exclusive end timestamps in UTC.
- [ ] Classify each launch metric as required or `N/A`: sessions, leads, funnel conversion,
  revenue, subscriptions, customers, refunds, and offer/OTO performance.
- [ ] Treat trial-to-paid conversion by locale as a required subscription metric: show trial
  starts, converted trials, and the percentage for every locale in the selected cohort.
- [ ] Treat renewal success by locale as a required subscription metric: deduplicate retries by
  invoice and show invoice attempts, first-attempt success, recovered invoices, eventual
  success, and both percentages for every locale.
- [ ] Treat average customer LTV as a required revenue metric: show realized all-time production
  net revenue after refunds/chargebacks divided by distinct paying customers, with the customer
  count and net-revenue total visible beside the average.
- [ ] Apply `supabase/migrations/00004_admin_core.sql` so the application uses the V2 locale
  and LTV aggregates; keep `00003_admin_metrics.sql` as its additive foundation.
- [ ] Define each KPI's numerator, denominator, statuses included, currency treatment, and
  sandbox/live filter before comparing it with a provider dashboard.
- [ ] Exclude failed, pending, duplicate, or unbooked attempts from revenue unless the KPI is
  explicitly measuring attempts.
- [ ] Avoid adding unlike currencies. Either show per-currency totals or use a documented FX
  source and conversion timestamp.
- [ ] Keep server queries bounded, indexed, and parallel where independent.
- [ ] Isolate optional-source failures so one unavailable provider produces a visible warning,
  not a blank dashboard.
- [ ] Add pagination or hard caps for any table that can grow without bound.
- [ ] Verify loading, empty, error, stale, and partial-data states for every tab.
- [ ] Verify charts have text equivalents, meaningful labels, sufficient contrast, and usable
  mobile overflow.
- [ ] Reconcile a known date range against database queries and provider totals; record the
  expected differences.

**Exit criterion:** each visible metric has a stable definition and can be reconciled from its
source data.

## 7. Build the support identity graph

- [ ] Normalize input with `trim()` and lowercase, validate length and email shape, and reject
  wildcard or control characters.
- [ ] Use exact equality for email lookup. Do not use `ILIKE`, substring, or fuzzy matching.
- [ ] Apply provider-specific aliases only if the application's own authentication logic uses
  the same normalization.
- [ ] Begin with the auth identity, then resolve linked user, checkout, order, subscription,
  entitlement, session, funnel, and product-activity identifiers in bounded stages.
- [ ] Deduplicate identifiers before querying downstream sources.
- [ ] Distinguish `registered`, `checkout/lead only`, `not found`, and `ambiguous` results.
- [ ] Display every duplicate identity that caused ambiguity and disable all mutations.
- [ ] Never trust a target user ID supplied by the browser; resolve the customer again from the
  exact email inside the mutation transaction/workflow.
- [ ] Label records with their provider account and deployment/payment environment.
- [ ] When a provider account is shared across projects, classify records through this
  project's known product/order graph so another project's customers remain hidden.
- [ ] Prefer stored ledgers/mirrors; use bounded, read-only live provider refreshes only where
  they materially improve the answer.
- [ ] Run independent live lookups concurrently with strict timeouts and no unbounded retries.
- [ ] Convert an optional source failure into a named partial-data warning.

Complete the source map for the project:

| Source | Required? | Exact join key(s) | Cap/timeout | Source of truth for | Status/evidence |
|---|---|---|---|---|---|
| Auth users / application sessions | Yes | | | identity and sessions | |
| User profile/preferences | Usually | | | locale, timezone, activity | |
| Orders / initial payments | Yes for paid products | | | purchase attempts | |
| Renewal events / subscriptions | Conditional | | | recurring payments | |
| Entitlements | Yes for member access | | | current access | |
| Funnel / analytics events | Usually | | | customer journey | |
| Fulfilment/delivery outbox | Conditional | | | delivery failures | |
| Refund/dispute evidence | Conditional | | | money returned/at risk | |
| Device and validated IP evidence | Conditional | | | operational evidence | |
| Product activity tables | Conditional | | | usage and progress | |
| Support action audit | Yes for actions | | | action history | |
| Live payment provider APIs | Conditional | | | latest provider state | |

**Exit criterion:** one exact email produces a deterministic, capped identity graph, and an
ambiguous identity can never be mutated.

## 8. Define and sanitize the support report

- [ ] Define an explicit, versioned TypeScript report contract; do not return arbitrary database
  rows or provider SDK objects.
- [ ] Select only allowlisted columns from each source.
- [ ] Exclude raw quiz answers, journal/message bodies, consent text, checkout form payloads,
  provider payloads, unfiltered metadata, webhook bodies, and internal exception stacks.
- [ ] Exclude passwords, cookies, session tokens, access/refresh tokens, saved-card tokens,
  claim hashes, signatures, API keys, push endpoints/keys, signed URLs, and storage paths that
  grant access.
- [ ] Exclude full card data and last-four/card brand unless a reviewed support use case requires
  the minimum field. Never expose a reusable payment credential.
- [ ] Validate and normalize IP evidence; deduplicate it and include it only when necessary for
  the approved support purpose.
- [ ] Sanitize source warnings and errors before returning them to the browser.
- [ ] Run a final recursive sanitizer/assertion before serialization as defense in depth.
- [ ] Make copy-summary and download-JSON features use exactly the same sanitized contract shown
  on screen.
- [ ] Ensure filenames and report metadata contain no credential or unnecessary customer data.
- [ ] Hash lookup identifiers before using them in rate-limit keys or application logs.
- [ ] Document the lawful purpose, access controls, and retention for personal data in the report.

**Exit criterion:** a captured API response can be shared with an authorized reviewer without
revealing credentials, raw content, or another project's data.

## 9. Support console experience

- [ ] Provide one clearly labelled exact-email search field; searching must not change state.
- [ ] Provide loading, empty, not-found, registered, checkout-only, ambiguous, partial, provider
  error, and unexpected-error states.
- [ ] Organize the report into project-neutral sections such as overview, identity/sessions,
  purchases, subscriptions, access, failures/refunds, activity, operations, timeline, and actions.
- [ ] Show timestamps with an explicit timezone and amounts with their currency.
- [ ] Label live vs sandbox/test evidence and the provider account when multiple accounts exist.
- [ ] Surface source warnings beside the affected section rather than hiding the whole report.
- [ ] Cap long tables in the UI and make truncation/pagination obvious.
- [ ] Prevent an older, slower lookup response from replacing a newer search result.
- [ ] Make refresh re-run the exact-email lookup without repeating a mutation.
- [ ] Confirm copy summary and JSON download contain only the sanitized report.
- [ ] Hide or disable actions the current role cannot run and state why.
- [ ] Require keyboard-accessible tabs, inputs, dialogs, alerts, and confirmation controls.
- [ ] Test mobile/tablet layouts and long identifiers without horizontal page breakage.
- [ ] Add a synthetic demo fixture only if it cannot touch production data/providers, uses
  documentation-only example values, and refuses every mutation.

**Exit criterion:** an authorized operator can understand a normal and a broken customer journey
without querying the database manually.

## 10. Guard every support action

Fill this matrix before implementing any mutation:

| Action | Approved? | Role | Preconditions/invariant | Idempotency | Audit + rollback | Owner/test |
|---|---|---|---|---|---|---|
| Send login code | | | existing exact account; no account creation | | | |
| Revoke sessions | | | exact account; not current admin | | | |
| Grant/revoke complimentary access | | | must not corrupt paid access | | | |
| Re-apply/re-link an entitlement | | | order belongs to email/environment | | | |
| Extend access / unlock product state | | | project-specific bounds | | | |
| Change credits or add-on access | | | project-specific source of truth | | | |
| Cancel subscription | | | provider ownership and state confirmed | | | |
| Refund payment | | | amount, currency, payment, reason confirmed | | | |
| Delete/export customer data | | | approved privacy workflow | | | |

For every approved action:

- [ ] Use a stable action name, a strict input schema, and bounded values.
- [ ] Require an explicit human confirmation showing the exact email and effect.
- [ ] Re-authenticate/re-authorize on the server; never rely on a disabled button.
- [ ] Re-resolve the exact customer on the server and refuse unknown, ambiguous, demo, or
  cross-environment targets.
- [ ] Verify ownership of the order/subscription/entitlement and the provider account before acting.
- [ ] Generate or accept a constrained idempotency key and define safe retry behavior.
- [ ] Insert a durable `attempted` audit record before any irreversible or external side effect.
- [ ] If that insert fails, return an error and perform no action.
- [ ] Mark the audit row `succeeded`, `failed`, or `refused` with sanitized details.
- [ ] Define compensation/rollback behavior for a mutation that succeeds but whose final status
  update fails.
- [ ] Keep billing state and application access as separate concepts; never imply that revoking
  access cancels billing or that cancellation automatically fixes entitlements.
- [ ] Rate-limit the action by actor/client and target digest.
- [ ] Return no provider secret, raw response, or internal stack to the browser.
- [ ] Refresh the report after success so the operator sees the resulting state.
- [ ] Unit-test success, validation failure, auth failure, ambiguity, wrong environment,
  duplicate retry, audit-insert failure, mutation failure, and final-audit failure.
- [ ] Write a support runbook for recovery and escalation before enabling the action in production.

**Exit criterion:** every enabled action is explicitly approved, server-authorized, idempotent,
audited before execution, bounded, recoverable, and tested. Unapproved actions do not appear.

## 11. Central reporting hub / API gateway (conditional)

Use this section only when the project must feed the shared CPO/CRO reporting layer shown in
the supplied architecture context. Keep the project admin functional when the hub is unavailable.

- [ ] Confirm the gateway owner, base URL, environments, service-level expectations, and support path.
- [ ] Obtain a unique permanent project ID/key; do not reuse another project's identity.
- [ ] Version the export schema and document canonical event and metric definitions.
- [ ] Treat `(project_key, deployment_environment, source_app, event_key)` as the producer
  identity and use a unique event/idempotency ID for each record.
- [ ] Export incrementally in stable `(created_at, id)` order while retaining the business
  `occurred_at` time and a per-project cursor.
- [ ] Send only the minimum approved operational/aggregate data. Do not send email addresses,
  free text, message bodies, quiz answers, credentials, or full URLs.
- [ ] Use a narrowly scoped server-side credential, TLS, timeout, retry with backoff, and an
  outbox/dead-letter strategy. Never call the gateway directly from the browser.
- [ ] Keep staging and production credentials, data, cursors, and dashboards isolated.
- [ ] Make export failure non-blocking for checkout, login, PWA use, and the project-local admin.
- [ ] Expose last successful sync, lag, rejected records, and retry state without exposing PII.
- [ ] Add contract tests for schema validation, idempotent replay, old/new schema versions,
  partial batches, authentication failure, timeout, and project isolation.
- [ ] If the hub can send commands back, build a separate authenticated command plane with
  per-action authorization, idempotency, durable local audit, expiry, and replay protection.
  Telemetry credentials must never authorize support mutations.
- [ ] Document historical backfill, cursor reset, key rotation, incident response, and disablement.

**Exit criterion:** the central integration is versioned, least-privilege, PII-minimized,
observable, replay-safe, and cannot break or control the local project accidentally.

## 12. Automated verification

- [ ] Unit-test email normalization, exact matching, status mapping, money/time formatting,
  identity deduplication, ambiguity detection, report sanitization, and source warnings.
- [ ] Test admin access helpers with missing, mixed-case, duplicate, and unauthorized emails.
- [ ] Test page and API access independently for signed-out, unauthorized, and authorized users.
- [ ] Test login-code enumeration resistance, invalid OTPs, expired sessions, logout, and local-only redirects.
- [ ] Test lookup rate limits, action rate limits, same-origin JSON enforcement, body-size limits,
  invalid content types, arrays, and malformed JSON.
- [ ] Test known fixtures: not found, registered only, checkout/lead only, successful purchase,
  failed payment, active/cancelled subscription, refund/dispute, entitlement mismatch, duplicate
  identities, partial provider failure, and shared-provider-account isolation.
- [ ] Test every forbidden key/category against the recursive sanitizer.
- [ ] Test that admin/support routes emit private/no-store, no-referrer, and noindex headers.
- [ ] Test that analytics, pixels, and session replay never initialize on internal routes.
- [ ] Test migrations, RLS, function grants, exact-lookup indexes, and missing-migration behavior.
- [ ] Run component/accessibility tests for search, tabs, warnings, confirmation, action results,
  copy summary, and JSON download.
- [ ] Run the focused admin/support suite, then TypeScript, lint, the full test suite, and production build.
- [ ] Record pre-existing unrelated failures separately; do not silently classify a new failure as existing.
- [ ] Inspect the production client bundle and browser network log for secrets and unexpected third-party calls.

Current boilerplate commands:

```bash
npm run admin:verify
npm run typecheck
npm run lint
npm run test
npm run test:db
npm run build
```

`npm run test:db` starts a throwaway PostgreSQL 17 container and therefore requires
Docker. CI runs the same command and treats any migration or SQL assertion failure as a
release failure.

**Exit criterion:** the focused and full checks pass, or every accepted exception has an owner,
reason, and deadline.

## 13. Staging acceptance

- [ ] Apply migrations to staging and verify the generated application types match them.
- [ ] Configure a staging-only allowlist and confirm a non-allowlisted account cannot enter.
- [ ] Verify direct calls to every admin/support API fail without valid authorization.
- [ ] Test OTP request, verification, refresh, sign-out, and expired-session behavior.
- [ ] Reconcile dashboard metrics for a known UTC date range and each supported currency/environment.
- [ ] Look up known fixtures for every required support state and compare evidence with the database/provider.
- [ ] Temporarily disable each optional provider credential and verify a partial warning appears.
- [ ] Verify an ambiguous customer cannot be mutated.
- [ ] Exercise approved actions only against staging/sandbox fixtures; confirm audit order,
  idempotent retry, visible result, and recovery instructions.
- [ ] Inspect cache, robots, and referrer headers on pages and APIs.
- [ ] Confirm no internal route or search term reaches analytics, advertising, replay, or error-tracking vendors.
- [ ] Test desktop and mobile layouts with keyboard-only navigation.
- [ ] If central export is enabled, verify authentication, project/environment isolation,
  idempotent replay, lag monitoring, and non-blocking gateway failure.
- [ ] Complete a security/privacy review of the actual support JSON response and action audit rows.
- [ ] Capture sign-off evidence and unresolved risks.

**Exit criterion:** staging demonstrates the complete operator journey without production data or
live payment side effects.

## 14. Production rollout and handover

- [ ] Obtain explicit approval for production migrations, environment changes, and deployment.
- [ ] Apply additive migrations before enabling UI paths that require them.
- [ ] Configure the production allowlist with the minimum initial staff group.
- [ ] Configure production labels, paths, analytics key, and optional integration credentials.
- [ ] Deploy and run read-only smoke tests before enabling any mutation.
- [ ] Confirm unauthorized page/API behavior, private/no-store/noindex headers, and tracker exclusion.
- [ ] Reconcile a small known production sample without copying sensitive output into tickets/chat.
- [ ] Enable approved actions one at a time and run only the pre-approved harmless smoke test.
- [ ] Confirm audit rows, rate-limit signals, source warnings, and central-export health are observable.
- [ ] Confirm logs contain correlation IDs and safe error categories, not customer PII or secrets.
- [ ] Document rollback/disable switches for admin access, each action, provider adapters, and hub export.
- [ ] Hand over the operator runbook, data definitions, access request/offboarding process,
  escalation contacts, secret rotation schedule, and known limitations.
- [ ] Schedule a post-launch reconciliation and access review.

**Exit criterion:** production is least-privilege, observable, reversible, documented, and owned.

## Definition of done

The Admin/Support step is complete only when all of the following are true:

- [ ] No reference-project branding, account identifiers, product configuration, or credentials remain.
- [ ] Every visible metric has a documented definition and reconciled evidence.
- [ ] Trial-to-paid conversion and renewal success are reconciled per locale, with retry and
  cohort rules documented.
- [ ] Average customer LTV is reconciled against all-time production net revenue and the distinct
  paying-customer population.
- [ ] Exact-email support lookup covers every required project data source and reports partial failures.
- [ ] The browser receives only the reviewed sanitized report contract.
- [ ] Page protection and API authorization both work independently.
- [ ] Every enabled action is approved, confirmed, server-revalidated, idempotent, and durably audited
  before its side effect; all other actions are absent.
- [ ] Migrations, generated types, RLS, tests, lint, type-check, and production build pass.
- [ ] Staging and production data, credentials, provider accounts, and central exports are isolated.
- [ ] Admin/support routes are uncached, non-indexed, no-referrer, and excluded from all trackers.
- [ ] Operations has a tested runbook for access, incidents, partial providers, failed actions,
  rollback, and escalation.
- [ ] Central hub/API gateway integration is either verified end-to-end or explicitly recorded `N/A`.
- [ ] The technical, support, security/privacy, and launch owners have signed off.

## Reusable implementation references

Use these as patterns, not as product configuration:

- `docs/admin-dashboard.md` — current boilerplate routes, adapters, and guarded-action rules.
- `docs/internal-analytics.md` — project-scoped, PII-minimized analytics/export contract.
- `docs/new-product-checklist.md` — whole-project sequencing and environment setup.
- `apps/funnel/src/admin.config.ts` — the one project-owned admin manifest.
- `packages/admin-core/` — reusable manifest, access, adapter, result, and request contracts.
- `apps/funnel/src/app/admin/` — shared shell, login, dashboard, support page, and queries.
- `apps/funnel/src/app/api/admin/` — independently authorized admin APIs.
- `apps/funnel/src/features/admin/support/` — sanitized support contract and formatting.
- `supabase/migrations/00002_admin_support.sql` — support action audit schema.
- `supabase/migrations/00003_admin_metrics.sql` — V1 metric foundation.
- `supabase/migrations/00004_admin_core.sql` — atomic rate limiting, action idempotency, and
  the V2 locale subscription/customer-LTV aggregates.
- `supabase/tests/admin_core.sql` — database permissions, concurrency, and metric behavior.

The sibling project implementations reviewed for this checklist contain useful examples of
provider adapters, partial-source reporting, IP validation, synthetic fixtures, rate limits,
sanitizers, and audited actions. Their brand copy, shared-link credentials, data models, and
product-specific mutations are deliberately **not** boilerplate defaults.
