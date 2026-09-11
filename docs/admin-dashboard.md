# Admin dashboard boilerplate

The funnel app owns a brand-neutral internal workspace at `/admin`:

- `/admin/dashboard` — funnel, revenue, subscription, customer, and offer analytics.
- `/admin/support` — exact-email customer evidence and guarded support actions.
- `/admin/audit` — recent support-action audit evidence for administrators.
- `/admin/health` — configuration, access-policy, FX, database, and RPC readiness.
- `/admin/login` — Supabase OTP authentication for configured staff.

The shared UI contains no product logo, product palette, or brand name. Runtime
labels come from `ADMIN_PROJECT_LABEL` and `ADMIN_APP_PATH`; product codes, enabled
modules, payment environment, cohort rules, adapter IDs, authentication limits, and support controls live
in the project-owned `apps/funnel/src/admin.config.ts` manifest.

## Adapt a new project

1. Edit `apps/funnel/src/admin.config.ts`. Keep only the modules and support actions
   the project actually owns. Map its subscription products and recurring offers.
2. Keep shared UI provider-neutral. Put project/provider queries behind the contracts
   in `packages/admin-core/src/adapters.ts` and register the adapter in
   `apps/funnel/src/features/admin/adapters/`.
3. Configure staff roles with `ADMIN_ACCESS=email:role,email:role`. Supported roles are
   `administrator`, `support`, `analyst`, and `viewer`. `ADMIN_EMAILS` remains a
   legacy administrator-only fallback when `ADMIN_ACCESS` is absent.
4. Configure `ADMIN_PROJECT_LABEL`, `ADMIN_APP_PATH`,
   `ADMIN_PAYMENT_ENVIRONMENT`, and all server-side Supabase values. Add
   `ADMIN_FX_RATES` for each non-EUR ledger currency used by the default adapter.
5. Apply migrations `00002_admin_support.sql`, `00003_admin_metrics.sql`, and
   `00004_admin_core.sql`, then regenerate `packages/shared/src/types/database.ts`.
6. Run `npm run admin:verify`, `npm run typecheck`, `npm run lint`, `npm run test`,
   `npm run test:db`, and `npm run build` before staging acceptance.
7. Complete `Admin-checklist.md` with project-specific owners and evidence.

The default `supabase-solidgate` analytics adapter reports in EUR. A project with a
different reporting currency must provide a corresponding adapter and formatter;
changing only `baseCurrency` is not sufficient.

## Access model

`ADMIN_ACCESS` maps exact, normalized emails to fixed roles:

| Role | Analytics | Support read | Support actions | Audit/health |
|---|---:|---:|---:|---:|
| `administrator` | Yes | Yes | Yes | Yes |
| `support` | No | Yes | Yes | No |
| `analyst` | Yes | No | No | No |
| `viewer` | Yes | Yes | No | No |

Invalid or conflicting entries are omitted, so malformed access configuration fails
closed. The proxy protects pages, and every `/api/admin/*` handler independently
authorizes the current Supabase user. The shell filters navigation by both manifest
module flags and capabilities; hidden navigation is never treated as authorization.

All admin responses are private and non-indexable. Internal routes are excluded from
the application analytics providers. Support POST routes additionally require
same-origin JSON, reject cross-site fetches and oversized/malformed bodies, and use an
atomic database-backed rate limit.

Admin OTP request and verification endpoints use the same request boundary. Allowlisted
OTP sends also consume the manifest's database-backed `otpRequestRateLimit`; rejected or
unavailable throttles return the same generic response as an unknown email.

## Data and adapter contract

`packages/admin-core` contains reusable, product-neutral contracts:

- `AdminProjectConfig` is the validated manifest shape.
- `AdminAnalyticsAdapter` and `AdminSupportAdapter` are provider boundaries.
- `AdminDataResult<T>` distinguishes `ready`, `partial`, and `unavailable` data and
  carries safe warnings, source, calculation time, and data-through time.
- access helpers define roles/capabilities in one place.
- request helpers enforce the common support API boundary.

The shipped `supabase-solidgate` adapter is the default implementation, not a shared
UI assumption. Its support report selects a versioned, sanitized contract rather than
returning raw database rows or provider payloads. Optional-source failures become
named warnings; required-source failures fail closed.

## Required subscription and value metrics

The subscription tab reports by locale for the selected UTC range:

- **Trial-to-paid:** converted mature trial cohorts divided by mature trial starts.
  Trials newer than `trialMaturityDays` are excluded from the denominator.
- **First-attempt renewal success:** invoices paid on their first recorded attempt
  divided by distinct renewal invoices.
- **Recovered renewals:** invoices that failed initially but later paid.
- **Eventual renewal success:** invoices with any successful attempt divided by
  distinct renewal invoices.

`admin_subscription_performance_by_locale_v2()` accepts the configured product-code
set, payment environment, and maturity window. It deduplicates retries by invoice and
prevents attribution joins from multiplying counts.

The revenue tab reports average realized customer LTV across all configured payment
history: net captured initial-order and renewal revenue after refunds/chargebacks,
converted to EUR, divided by distinct paying customer identities. The customer count
and net-revenue total remain visible beside the average. Missing FX rates produce an
explicit unavailable/partial result; they never silently assume 1:1 conversion.

`admin_customer_ltv_by_currency_v2()` and the locale aggregate are introduced by
`00004_admin_core.sql`. `00003_admin_metrics.sql` remains the additive V1 foundation;
new application code uses the V2 functions.

## Support evidence and actions

The default support adapter links bounded evidence from auth identities, sessions,
preferences, orders, renewals, entitlements, funnel events, fulfillment operations,
and the support audit. It searches one normalized exact email. Raw quiz answers,
provider payloads, credentials, saved-card tokens, and signed URLs are not part of the
browser contract.

The reusable actions are deliberately narrow:

- `send_login_code` sends an OTP with account creation disabled.
- `revoke_sessions` signs the customer out without changing billing or entitlement.

Actions are enabled in `admin.config.ts`, require the `support:act` capability, resolve
the exact identity again on the server, refuse ambiguity and self-revocation, consume
an atomic action rate limit, and require a UUID idempotency key. A durable
`support_action_audit` attempt is inserted before the side effect. Its unique key
prevents the same actor/action/request from executing twice.

Refunds, cancellations, credits, product unlocks, and manual entitlements are not
generic actions. Add one only with project-specific authorization, validation,
ownership checks, idempotency, audit order, compensation, tests, and an operator
runbook.

## Operational verification

`npm run admin:verify` validates the manifest, adapter registration, access policy,
FX syntax, migration presence, and expected generated-type symbols. CI runs a
structure-only version without secrets, typecheck, lint, all tests, a production build,
and `npm run test:db` against a throwaway PostgreSQL 17 container.

The database behavior suite validates migrations, role grants, atomic rate limiting,
audit idempotency, immature-trial exclusion, retry deduplication, and recovered-renewal
classification. Local execution requires Docker.

The central CPO/CRO hub shown in the project architecture is intentionally optional.
The local admin remains functional without it. Do not invent its API or credentials;
complete the conditional hub section in `Admin-checklist.md` only after its owner and
versioned contract are confirmed.
