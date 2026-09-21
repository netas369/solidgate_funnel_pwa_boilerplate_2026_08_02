# Database behaviour tests

Plain `psql` scripts that assert what the money-critical RPCs actually do. They
run against a throwaway Postgres, not your local Supabase stack, so they can be
run on any branch without touching real data.

Every assertion is a `DO $$ ... ASSERT ... $$` — the script aborts loudly on the
first failure and prints a `... PASSED` banner when it does not.

These scripts cover the PL/pgSQL money logic. The application-level test
suites cannot reach it: the behaviour lives entirely inside the database.

## Running them

The whole schema is one file, so the recipe is one file too.

```sh
set -e

docker run -d --name sgtest --tmpfs /pgdata:rw,size=512m \
  -e PGDATA=/pgdata -e POSTGRES_PASSWORD=postgres postgres:17-alpine
sleep 5

# A bare image has none of the Supabase scaffolding the schema assumes.
docker exec sgtest psql -U postgres -v ON_ERROR_STOP=1 -c "
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role BYPASSRLS;
  CREATE ROLE supabase_admin LOGIN SUPERUSER;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
  CREATE TABLE auth.sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
  CREATE TABLE auth.refresh_tokens (
    id BIGSERIAL PRIMARY KEY, session_id UUID, revoked BOOLEAN DEFAULT false);
  CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS 'SELECT NULL::UUID';
  -- Supabase grants anon/authenticated/service_role table privileges by
  -- default. Reproduce that BEFORE the schema is created, so the baseline's
  -- explicit REVOKEs are the thing under test rather than an artefact of a
  -- bare Postgres.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
  -- The CRO read API gates on the caller's email claim. Without this stub every
  -- cro_* function fails to CREATE, because is_cro_analyst() is LANGUAGE sql and
  -- is parsed at creation time.
  CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS
    'SELECT COALESCE(NULLIF(current_setting(''request.jwt.claims'', true), '''')::JSONB, ''{}''::JSONB)';
"

docker exec -i sgtest psql -U postgres -v ON_ERROR_STOP=1 -q \
  < supabase/migrations/00001_baseline.sql

for t in supabase/tests/*.sql; do
  echo "== $t"
  docker exec -i sgtest psql -U postgres -v ON_ERROR_STOP=1 \
    -v "round2_dblink_conn=host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" \
    < "$t"
  if [ "$t" = "supabase/tests/solidgate_round2_concurrency.sql" ]; then
    docker exec -i sgtest psql -U postgres -v ON_ERROR_STOP=1 \
      -v "round2_dblink_conn=host=127.0.0.1 port=5432 user=postgres password=postgres dbname=postgres" \
      < "$t"
  fi
done

docker rm -f sgtest
```

Four details in that setup are load-bearing and easy to get wrong:

- **`service_role BYPASSRLS`.** Real Supabase grants it. Without it every table
  read in these scripts silently returns zero rows and the assertions fail for
  the wrong reason.
- **`ALTER DEFAULT PRIVILEGES` before the schema, not after.** Granting after
  the baseline runs re-grants the tables the baseline deliberately revoked
  (`solidgate_card_update_attempts`,
  `solidgate_subscription_token_sync_jobs`), and the ACL assertions fail.
- **Default-grant to all THREE roles, not just `service_role`.** This block used
  to grant only `service_role` while its own comment claimed to reproduce
  Supabase's defaults. Under-granting makes every "this role cannot read X"
  assertion pass for the wrong reason — the role could not read *anything*, so
  the baseline's explicit REVOKEs were never the thing under test. With the
  defaults correct, `authenticated` reaches `sessions` and gets zero rows from
  RLS, while `quiz_definition_steps` and `cro_analysts` are denied outright.
- **`auth.jwt()` must exist.** Supabase provides it; a bare Postgres does not,
  and `is_cro_analyst()` will not CREATE without it.
- **`supabase_admin`.** Supabase owns `auth.users`; some scripts reconnect as
  that role to insert fixture users rather than granting the application roles
  write access to the auth directory.
- **`dblink` in `extensions`.** The concurrency suite calls
  `extensions.dblink_*` explicitly. Installing the extension in `public` leaves
  those functions unavailable even though extension installation succeeded.

Start with a fresh database for each complete run. Some scripts, including
`solidgate_intro_claims.sql`, commit their fixtures and are not repeatable
against that same database without resetting it.

The release gate is successful only when every script prints its banners and
`solidgate_round2_concurrency.sql` can be run **twice in succession** — that is
what proves its cleanup is retry-safe.

## Changing the schema

`00001_baseline.sql` is the fresh-install schema; additive migrations upgrade
existing installations. Verify both a fresh baseline and the full migration
chain. Extend the relevant script here
*before* changing any of the functions it covers — the behaviour these scripts
pin is not visible from the application layer, and a regression surfaces as a
buyer being charged twice, not as a failing unit test.

## `cro_dashboard.sql`

The CRO read API: authorization and aggregate behaviour. A separate script from
`quiz_backend.sql` because it needs a *population* rather than one narrative
session — two locales, two devices, a session with empty `step_activity`, and
one inside the settle window.

The authorization half is the whole security boundary, not a nicety: `apps/cro`
holds the anon key and no service-role key, so these functions are the only way
it reads anything. It pins that a non-analyst gets **42501** specifically (the
app branches on the SQLSTATE), that a JWT with no `email` claim is refused, that
an empty address cannot be stored, and — the premise everything rests on — that
`authenticated` cannot reach `quiz_definition_steps` or `cro_analysts` at all
and sees zero rows of `sessions`.

Two assertions are worth more than the rest. A loop over every `cro_*` function
asserts EXECUTE is granted to `authenticated` and denied to `anon`, so a
function added later without its REVOKE fails a test instead of shipping open.
And `cro_answer_distribution` is asserted **positively** to return
`value_kind = 'freeform'` with a NULL value for the email step, whose fixture
session really does carry an address — `email` and `fullName` are declared
answer keys, so a naive distribution would publish them.

## `quiz_backend.sql`

Covers the two-table quiz contract: session creation, one-row JSONB snapshots,
optimistic revision conflicts, event idempotency, and immutable completion.
It rolls back all fixtures.

---

## `solidgate_intro_claims.sql`

Covers `claim_solidgate_intro_offer` and `consume_solidgate_intro_offer`: who
may open a checkout, who may take over an abandoned one, and what happens when
a buyer is charged for a subscription the ledger did not expect.

These exist because an earlier version of the ledger locked every buyer who
abandoned a checkout out of paying **permanently**.

Non-obvious invariants the assertions pin down:

- a returning buyer on a **new session** (fresh quiz run, incognito, another
  device) may re-key an abandoned checkout **immediately**; there is no lease
  to wait out, because that lease is exactly what produced the lockout;
- a **pending** order never blocks a re-claim — every checkout is written as
  `pending` before the intent is issued, so blocking on it would make the whole
  recovery path unreachable;
- a `pending` order whose payment actually _started_ (`auth_ok`, `3ds_verify`,
  `processing`, `settle_ok`, `partial_settled`) **does** block: the card is
  charged or about to be, and re-keying would mint a second payable intent for
  the same email during the settle window;
- an order in any state past `pending`/`failed` blocks, in the same session as
  well as across sessions;
- `reassigned` and `superseded` are different answers — only `superseded` means
  a second subscription was charged and someone is owed a refund.

## `solidgate_round2_concurrency.sql`

The crown jewel. It uses `dblink` to hold two real transactions open at once, so
these are genuine lock/visibility tests rather than sequential approximations of
a race. It proves:

- the legacy Boolean and the fenced v2 webhook claims serialize, completed
  duplicates stay completed, and a legacy stale-lease takeover invalidates the
  old v2 fence;
- main hosted-checkout RPC followers and rolling direct writers serialize on the
  same key in both arrival orders: RPC-first exposes one identity/builder, while
  direct-first is adopted without minting a second provider order id;
- an expired main merchant-data builder lease can be taken over only on the same
  order, the displaced builder cannot finalize, finalized payloads replay
  exactly, and a provider-terminal retry advances to precisely attempt `N+1`;
- the atomic OTO opener and a rolling-deployment direct insert take the same
  advisory lock, producing one order and one provider submitter;
- an expired OTO submission lease yields a reconcile-only claim on the same
  provider order id, and only that claim can resume submission;
- all OTO3 bundle variants share one canonical step, so a buyer can never hold
  two live orders for the same funnel step;
- two member-area openers serialize on `(environment, user, canonical product)`,
  reuse one provider order id, and expose exactly one saved-card submitter;
- expired member-area saved-card ownership is reconcile-only and token-fenced;
  an exact terminal zero-net result preserves original gross before permitting
  attempt `N+1`; a definite no-provider-order `request_rejected` result is
  idempotently retired while contradictory money/subscription/3DS evidence is
  rejected; and a captured-but-unfulfilled result stays on the same pending
  order;
- refunded/canceled history permits exactly the next attempt at its current
  amount, currency, locale, or catalog price;
- purchase mode and canonical price/locale bindings cannot change on an existing
  attempt, while late optional UTM attribution is ignored;
- hosted-form builders are fenced and publish one cached merchant payload;
  followers get that payload with no builder/submission/reconcile ownership;
- a `processing` card result may durably carry an HTTPS 3DS `verify_url`, and a
  conflicting `3ds_verify` observation durably clears stale ACS URLs.

If you delete the legacy `claim_solidgate_webhook_event` (v1) from the baseline,
delete the legacy scenarios here in the same commit.

## `solidgate_oto_progress.sql`

Covers `advance_solidgate_oto_progress`: the 1→8 OTO chain never regresses, and
catch-up is reserved for provider-verified purchases.

## `solidgate_pwa_3ds_alias_conflict.sql`

Focused rollback-only regression for the member-area
`pending + 3ds_verify + NULL verify URL` contract. Proves a conflicting current
provider envelope clears both durable cached ACS copies.

## `solidgate_card_update_state.sql`

Proves newest-attempt return URLs, direct vault-write rejection, account-card
source chronology, and claim-fenced subscription-token synchronization.

A vault generation is eligible for an existing provider subscription only when
its source sequence is strictly newer than the exact subscription-owning order;
an older card can never be pushed onto a newer subscription. Its key race
inserts a newer card source while the old provider worker owns the job, then
proves that a captured source with a temporarily missing token becomes a durable
`awaiting_token` watermark which atomically fences that worker. The same exact
source may later fill the token (including after an exact partial refund and
`past_due`/`canceled` lifecycle change), whereas a stale source, saved-card
charge, reversal, or mismatched same-source token cannot restore or replace it.

## `solidgate_payment_identity.sql`

Proves immutable provider checkout snapshots, operator-only legacy
reconciliation, monotonic session/account card sources, and member-area capture
publication. Its recovery cases cover saved-card crashes before result
persistence, `requires_action` ACS returns, and an older exact paid order whose
current purchase state already points to a strictly newer attempt.

## `solidgate_token_origin_payment_type.sql`

Proves that provider-reported token origin stays bound to the exact monotonic
vault generation and survives safe promotion. It also proves the zero-auth
boundary: missing, invalid, or Click to Pay provenance cannot satisfy the
`special_free` access guard, while an exact Apple Pay token can.

## `solidgate_subscription_renewals.sql`

Exercises subscription entitlement changes with the real lifecycle RPC and
database triggers. It proves expired main trial access becomes a full paid
period, a weekly add-on recovers from `past_due`, and duplicate callbacks do not
add another billing period. Initial grant replays and older active callbacks
cannot shorten paid access or downgrade it to a trial. Recovery from grace
uses the actual paid expiry, even when the grace deadline was later.

It also verifies that an older subscription cannot replace a newer entitlement
owner, environment mismatches cannot change access, and refunds and revocation
tombstones still block grants. All fixtures roll back. Provider invoice
validation and period-end calculation are covered separately by the webhook
tests; this suite checks that the resulting access is actually persisted.


## 2026-09-14 financial audit regressions

`solidgate_financial_events.sql` exercises the immutable movement reducer,
monotonic cumulative refunds, overlapping chargebacks, outbox rollback,
capture transaction deduplication, browser capture publication, checked restore,
and restricted table/function access. `solidgate_financial_reporting.sql`
verifies 1101 payments are aggregated without Data API truncation, native
currencies remain separate, refunds retain their event dates, and canceled
subscribers remain historical paid conversions.

The baseline includes the financial and reporting migrations. Also test a fresh
installation by applying both dated migrations after the baseline: the repeated
schema setup must succeed. For an existing installation, apply the dated
migrations in order, preserving the original pre-migration database for rollback
and provider reconciliation. No production mutation is part of these tests.


## `solidgate_financial_events.sql`

Exercises the atomic financial reducer against real PostgreSQL: late capture
following a refund, equal-time decreasing refund snapshots, chargeback/refund
interleavings and reversals, exact outbox rollback, individual settlement
transaction deduplication, actual undercapture, and refunded renewals. It also
checks provider-confirmed restoration of cancellation, financial barriers inside
the entitlement RPC, partial-refund fulfillment, and the browser capture bridge.
History and mutation RPC grants are checked for public/client roles. Fixtures
roll back.

## `solidgate_financial_concurrency.sql`

Uses two independent `dblink` transactions to prove that capture/refund and
competing cumulative refunds serialize on the same order, keep monotonic amounts,
and conserve ledger deltas. Run twice to verify fixture cleanup. Committed
concurrency fixtures use `helpers/clear_financial_test_orders.sql` to explicitly
remove their own immutable test history before deleting parents. That helper is
only for a throwaway database; production history remains protected.


`payment_captured` analytics events are diagnostic observations and deliberately
omit `revenue`; they retain captured totals and movement deltas in cents. The
canonical purchase/subscription event reports the full collected amount once,
using the shared browser/server deduplication key. Refund and chargeback events
report their reversal deltas. Compute financial totals from
`solidgate_financial_movements` (or the reporting RPC), not by summing arbitrary
analytics event families. A partial 1200-cent capture followed by a completed
1767-cent purchase must expose 1767 cents of canonical revenue, never 2967.

Account card promotion additionally requires `orders.auth_verified_at` for the
exact main checkout source. Checkout email matching, automatic `user_id`
assignment and historical `claimed_at` values do not satisfy that requirement.
The token provenance suite proves a verified claim permits promotion; the card
state suite proves an unverified newer checkout cannot overwrite an existing
account card or fence its in-flight subscription token update, with or without
a new card token. Existing rows remain unverified until an actual authenticated
claim is completed.
