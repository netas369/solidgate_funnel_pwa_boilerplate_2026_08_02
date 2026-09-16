# Solidgate production cutover runbook

This release changes payment identity, webhook lifecycle, OTO exclusivity, and
saved-card ownership contracts. It is a **maintenance cutover**, not a rolling
database migration. Checkout and webhook delivery stay paused until all hard
gates pass.

No command in this document has been run against production by this audit.

## 1. External prerequisites

- Live Solidgate channel has the API (`api_pk_` / `api_sk_`) and webhook
  (`wh_pk_` / `wh_sk_`) key pairs.
- The same approved **static** statement descriptor is configured on every active
  channel/connector route and agrees with every localized billing disclosure.
  Newly built main/trial, OTO2, one-time OTO, PWA, and card-replacement requests
  must omit `dynamic_descriptor` and product-specific suffixes; renewals must
  follow the static provider configuration. Verify existing
  subscription renewals against provider configuration as well as new purchases;
  local code changes do not update previously retained provider values.
  Already-started checkouts may replay pre-release encrypted `merchant_data`
  containing an old suffix until they complete or expire. Preserve the same
  cached payload and order identity; do not reset a payable checkout to change
  its statement label. New builders do not add the field.
  Keep locale-based product codes and `order_description` separate from this
  static statement label. Any real statement-test payment requires prior
  explicit approval and a monetary limit.
- Live product catalog verification passes. The catalog is merchant-scoped and
  shared by sandbox/live; do not seed it again merely for cutover.
- Funnel Production uses `SOLIDGATE_ENVIRONMENT=production`; Preview uses
  `sandbox`. Both Funnel and PWA have the matching API pair.
- Funnel has independent strong `INTERNAL_API_SECRET` and `CRON_SECRET` values.
- Solidgate has verified `www.<your-funnel-domain>` and
  `www.<your-app-domain>`. Apple Pay is enabled for the Funnel and PWA purchase
  forms with `apple_pay_merchant_name` and the JS integration used outside
  Safari. Google Pay stays disabled until its merchant ID and Google-side
  verification are complete.
- Saved-token upsells follow Solidgate Support's 2026-07-22 channel guidance:
  card/network-token origins use `payment_type: "1-click"`; Apple Pay and
  Google Pay origins use `payment_type: "rebill"`. Missing, conflicting,
  unknown, or Click to Pay provenance is never charged as a saved method.
- Confirm from the Solidgate channel history that neither wallet was enabled
  before this release. The current vault records source order chronology but
  not payment-method type, so a historical wallet-derived token cannot be
  distinguished locally from a reusable card token. If either wallet was ever
  live, stop the cutover and reconcile those exact source orders with Solidgate
  before allowing saved-card purchases; absence cannot be inferred from the
  database alone.
- A named operator can pause/queue Solidgate webhook delivery and can inspect
  exact provider orders without copying identifiers into shared logs.

## 2. Release contents

The complete pending chain is thirteen migrations, in this order:

1. `20260721085110_solidgate_oto_durable_fulfillment.sql`
2. `20260721090209_solidgate_webhook_claim_states.sql`
3. `20260721091117_solidgate_main_checkout_atomic_open.sql`
4. `20260721105000_solidgate_round2_corrective_reapply.sql`
5. `20260721105632_solidgate_pwa_purchase_atomic_open.sql`
6. `20260721123000_solidgate_main_enrichment_outbox.sql`
7. `20260721124000_solidgate_payment_identity.sql`
8. `20260721124500_solidgate_oto_step_hardening.sql`
9. `20260721125000_solidgate_card_update_state.sql`
10. `20260721130000_solidgate_equal_timestamp_entity_ordering.sql`
11. `20260721140620_solidgate_oto_progress.sql`
12. `20260721195840_solidgate_special_free_card_entitlement_guard.sql`
13. `20260722084816_solidgate_token_origin_payment_type.sql`

Important boundaries:

- Through `123000` is compatible staging infrastructure.
- `124000` marks historical orders/session tokens legacy and revokes old
  checkout RPCs. From this point the release is **forward-only**: do not roll
  back to the old app or webhook.
- `124500` refuses to install while identity/session-vault reconciliation or
  canonical OTO-step duplicates remain.
- `125000` installs exact-source session/account vault fencing and durable
  newest-generation subscription-token synchronization.
- The old webhook must not process events after `130000`; it does not implement
  the equal-timestamp contract. Because this is a maintenance cutover, keep
  delivery paused through the final database stage, then deploy and probe the
  final handler before delivery resumes.
- `195840` prevents a `special_free` entitlement without a durable reusable
  credential. `22084816` binds that credential to its provider-reported origin
  and must be applied before deploying the method-aware app/webhook callers.

## 3. Read-only preflight

Disable checkout traffic before resolving anything reported here. The query is
aggregate-only and intentionally emits no customer, session, database-order,
or provider-order identifiers.

OTO3's four products are one mutually exclusive step, so duplicate detection
must group by canonical step—not by product slug.

```sql
WITH classified AS (
  SELECT
    payment_environment,
    CASE
      WHEN product_slug = 'BRAND_000000_SUB' THEN 'main'
      WHEN session_id IS NULL THEN 'pwa:' || COALESCE(product_slug, '<null>')
      ELSE 'oto:' || COALESCE((CASE product_slug
        WHEN 'BRANDLIFETIME_000000_SUB' THEN 1
        WHEN 'BRANDADDON_000000_SUB' THEN 2
        WHEN 'BRANDBUNDLE_000000_PDF' THEN 3
        WHEN 'BRANDBUNDLE1_000000_PDF' THEN 3
        WHEN 'BRANDBUNDLE2_000000_PDF' THEN 3
        WHEN 'BRANDBUNDLE3_000000_PDF' THEN 3
        WHEN 'BRANDPDF4_000000_PDF' THEN 4
        WHEN 'BRANDPDF5_000000_PDF' THEN 5
        WHEN 'BRANDPDF6_000000_PDF' THEN 6
        WHEN 'BRANDPDF7_000000_PDF' THEN 7
        ELSE NULL
      END)::TEXT, 'unknown')
    END AS canonical_flow,
    COALESCE(session_id::TEXT, user_id::TEXT) AS owner_key
  FROM public.orders
  WHERE psp = 'solidgate'
    AND COALESCE(session_id::TEXT, user_id::TEXT) IS NOT NULL
    AND NOT COALESCE(
      status IN ('canceled', 'expired', 'refunded')
      OR (
        status = 'failed'
        AND COALESCE(solidgate_original_amount_cents, amount_cents) > 0
        AND amount_cents = 0
        AND solidgate_payment_status IN (
          'auth_failed', 'declined', 'void_ok', 'request_rejected'
        )
      ),
      FALSE
    )
), duplicate_keys AS (
  SELECT payment_environment, canonical_flow, owner_key, COUNT(*) AS orders
  FROM classified
  GROUP BY payment_environment, canonical_flow, owner_key
  HAVING COUNT(*) > 1
)
SELECT payment_environment,
       canonical_flow,
       COUNT(*) AS duplicate_groups,
       SUM(orders) AS affected_orders
FROM duplicate_keys
GROUP BY payment_environment, canonical_flow
ORDER BY payment_environment, canonical_flow;
```

The query against the production database must return no rows for either
`production` or `sandbox`. If it does:

1. In an access-controlled incident record, inspect every exact Solidgate
   order for each reported owner/flow.
2. Retain only the provider-proven capture or single intended payable order.
   Void/cancel other provider-payable identities first.
3. In a short transaction, align local lifecycle state from that evidence.
   Never delete ledger rows and never infer provider finality from local
   `pending`/`failed` alone.
4. For OTO3, resolve all four variants together.
5. Record only counts, operator, and timestamp in the shared cutover log.

The restored-data rehearsal found exactly one duplicate group: four sandbox
OTO1 rows (three excess) for product `BRANDLIFETIME_000000_SUB`. The
preflight intentionally did not choose a winner. Temporary terminal statuses
used only to prove the remaining migrations compile are not provider evidence
and must not be copied to production. Provider-backed winner selection and
ledger reconciliation remain a launch blocker; a migration flag must not
bypass them.

## 4. Maintenance sequence

### Phase A — compatible migrations through `123000`

1. Disable Funnel and PWA checkout entry points.
2. Let already-started payment returns settle, then run the duplicate preflight.
3. Apply only migrations through `123000`.

### Phase B — pause delivery, apply `124000`, reconcile identities

1. Pause/queue Solidgate webhook delivery in the HUB. If the provider cannot
   pause it, deploy the hardened handler and deliberately allow its fail-closed
   5xx responses to retry until all required RPCs exist.
2. Apply `124000` alone.
3. Do not serve old application/webhook revisions after this point.
4. Run provider-evidence reconciliation in dry-run mode, then `--apply` with a
   direct project-owner database URL. The script is dry-run by default and
   application is not available through `service_role`.

```bash
set -euo pipefail

export SOLIDGATE_ENVIRONMENT=production
export NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='…'
export SUPABASE_DB_URL='postgresql://postgres.<ref>:…@<pooler>:5432/postgres?sslmode=require'
export SOLIDGATE_API_PUBLIC_KEY='api_pk_…'
export SOLIDGATE_API_SECRET_KEY='api_sk_…'

npx tsx scripts/solidgate-reconcile-payment-identities.ts

# Repeat with the same reviewed environment and explicit write authority.
# Store detailed output only in the restricted incident record.
npx tsx scripts/solidgate-reconcile-payment-identities.ts --apply

# Repeat both commands for every sandbox row stored in this production DB.
# Use the sandbox channel's API pair; keep the same Supabase project/DB values.
export SOLIDGATE_ENVIRONMENT=sandbox
export SOLIDGATE_API_PUBLIC_KEY='api_pk_sandbox_…'
export SOLIDGATE_API_SECRET_KEY='api_sk_sandbox_…'
npx tsx scripts/solidgate-reconcile-payment-identities.ts
npx tsx scripts/solidgate-reconcile-payment-identities.ts --apply
```

5. Exact provider evidence may source-bind a legacy session token only when the
   token itself matches. Unmatched historical tokens must be hard-zeroed by the
   owner-only operator path; never bind them from a current profile or “latest
   order”. After recording the exact provider evidence in the restricted
   incident record, run this separately for each unmatched session and require
   `cleared = true`:

```sql
BEGIN;
DO $$
BEGIN
  IF NOT public.clear_solidgate_legacy_session_vault(
    p_payment_environment := 'sandbox', -- or 'production'
    p_session_id := '<exact-session-uuid>'::uuid
  ) THEN
    RAISE EXCEPTION 'legacy session vault was not cleared';
  END IF;
END $$;
COMMIT;
```

   This intentionally removes the unusable legacy token and its display/source
   metadata. It is not exposed to `service_role` or application roles.
6. Run the aggregate hard gate only after reconciliation and token clearing
   have completed for **both** payment environments:

```sql
DO $$
DECLARE
  v_legacy_orders BIGINT;
  v_legacy_tokens BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_legacy_orders
  FROM public.orders
  WHERE psp = 'solidgate'
    AND solidgate_checkout_identity_legacy;

  SELECT COUNT(*) INTO v_legacy_tokens
  FROM public.solidgate_session_vault
  WHERE card_token IS NOT NULL
    AND (
      card_source_legacy
      OR card_source_order_id IS NULL
      OR card_source_created_at IS NULL
      OR card_source_sequence IS NULL
    );

  IF v_legacy_orders <> 0 OR v_legacy_tokens <> 0 THEN
    RAISE EXCEPTION
      'Solidgate cutover blocked: % legacy orders, % legacy session tokens',
      v_legacy_orders,
      v_legacy_tokens;
  END IF;
END $$;
```

### Phase C — resolve canonical OTO duplicates, apply `124500` + `125000`

Re-run the canonical duplicate query. It must return no rows. Apply `124500`
and `125000`; their own preflight/constraints are the final guard.

Keep the old application and webhook revisions inactive while traffic and
webhook delivery remain paused. The final revisions call method-aware vault
RPCs from `22084816`, so they must not be deployed at this phase.

Set the shared project secrets from an owner-controlled, mode-0600 temporary
env file. It must contain the production and sandbox webhook key pairs,
production Funnel/PWA URLs, production worker secret, and the explicitly
credentialed Preview worker target. Supabase injects `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`; do not add them to the file.

```dotenv
SOLIDGATE_WEBHOOK_PUBLIC_KEY=wh_pk_live_…
SOLIDGATE_WEBHOOK_SECRET_KEY=wh_sk_live_…
SOLIDGATE_WEBHOOK_PUBLIC_KEY_SANDBOX=wh_pk_sandbox_…
SOLIDGATE_WEBHOOK_SECRET_KEY_SANDBOX=wh_sk_sandbox_…
NEXT_PUBLIC_FUNNEL_URL=https://<production-funnel-host>
NEXT_PUBLIC_PWA_URL=https://<production-pwa-host>
INTERNAL_API_SECRET=<same-strong-secret-as-production-funnel>
SOLIDGATE_SANDBOX_FULFILLMENT_URL=https://<preview-funnel-host>/api/internal/solidgate-fulfillment
SOLIDGATE_SANDBOX_FULFILLMENT_SECRET=<same-strong-secret-as-preview-funnel>
NEXT_PUBLIC_POSTHOG_KEY=<production-key>
NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
# Add AC_INTERNAL_SECRET and SLACK_DISPUTE_WEBHOOK_URL only when enabled.
```

```bash
set -euo pipefail

export SOLIDGATE_PROJECT_REF='<ref>'
linked_ref="$(tr -d '\r\n' < supabase/.temp/project-ref)"
test "$linked_ref" = "$SOLIDGATE_PROJECT_REF"

umask 077
solidgate_secrets_file="$(mktemp)"
trap 'rm -f -- "$solidgate_secrets_file"' EXIT
vi "$solidgate_secrets_file"

npx --yes supabase@2.90.0 secrets set \
  --env-file "$solidgate_secrets_file" \
  --project-ref "$SOLIDGATE_PROJECT_REF"
rm -f -- "$solidgate_secrets_file"
trap - EXIT
```

After Phase D applies the remaining migrations and deploys both final webhook
functions, smoke-check both unsigned contracts (400 is expected) and verify
the release contract header before any webhook or checkout traffic resumes:

```bash
set -euo pipefail

: "${SOLIDGATE_PROJECT_REF:?Set the reviewed project ref}"
linked_ref="$(tr -d '\r\n' < supabase/.temp/project-ref)"
test "$linked_ref" = "$SOLIDGATE_PROJECT_REF"

probe_webhook_contract() {
  local function_name="$1"
  local headers_file status
  headers_file="$(mktemp)"
  if ! status="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 10 --max-time 30 \
      --dump-header "$headers_file" \
      -X POST \
      "https://${SOLIDGATE_PROJECT_REF}.supabase.co/functions/v1/${function_name}" \
      -H 'content-type: application/json' \
      --data '{}')"; then
    rm -f -- "$headers_file"
    return 1
  fi
  if test "$status" != '400' || ! grep -Eiq \
      '^x-solidgate-webhook-contract:[[:space:]]*20260722084816[[:space:]]*$' \
      "$headers_file"; then
    rm -f -- "$headers_file"
    return 1
  fi
  rm -f -- "$headers_file"
}

probe_webhook_contract solidgate-webhooks
probe_webhook_contract solidgate-webhooks-sandbox
```

### Phase D — final migrations, deploy, UAT, resume

1. While checkout and webhook delivery are still paused, apply `130000`,
   `140620`, `195840`, and `22084816` as one reviewed final database stage.
2. Deploy the final Funnel/PWA revisions and both webhook functions. The final
   webhook build advertises contract `20260722084816` and may now call its
   method-aware vault RPCs.

```bash
npx --yes supabase@2.90.0 functions deploy solidgate-webhooks \
  --project-ref "$SOLIDGATE_PROJECT_REF"
npx --yes supabase@2.90.0 functions deploy solidgate-webhooks-sandbox \
  --project-ref "$SOLIDGATE_PROJECT_REF"
```

3. Run both contract probes above. Any response other than the expected 400
   plus contract header is a hard stop.
4. Deploy/wake `/api/internal/solidgate-fulfillment`. Its five-minute cron now
   recovers lifetime cancellation, PDFs, welcome/profile enrichment, and
   newest-generation subscription card-token synchronization.
5. Run sandbox UAT for:
   - main hosted form and 3DS return with a visible verification screen;
   - OTO accepted-pending immediate advance;
   - later OTO `3ds_verify` return to the exact original order;
   - OTO8 blocking Open App while any accepted order remains ambiguous;
   - PWA hosted/saved-card purchase and update-card full-page 3DS;
   - refund, dunning, paid recovery, cancellation, and duplicate webhook replay.
6. Resume queued webhook delivery before checkout traffic. Confirm retries
   drain to completion, then reopen one low-volume locale and widen gradually.

## 5. Exact staged migration commands

`supabase db push` has no target-version flag. Build three reviewed staged
directories plus the full final tree; never mark versions applied manually.

```bash
set -euo pipefail

export SOLIDGATE_PRODUCTION_DB_URL='postgresql://…'
export SOLIDGATE_PROJECT_REF='…'
readonly SUPABASE_CLI_VERSION='2.90.0'

linked_ref="$(tr -d '\r\n' < supabase/.temp/project-ref)"
test "$linked_ref" = "$SOLIDGATE_PROJECT_REF"
node -e '
  const url = new URL(process.env.SOLIDGATE_PRODUCTION_DB_URL);
  const ref = process.env.SOLIDGATE_PROJECT_REF;
  const user = decodeURIComponent(url.username);
  if (!(url.hostname === `db.${ref}.supabase.co` ||
        (url.hostname.endsWith(".pooler.supabase.com") &&
         user === `postgres.${ref}`))) {
    throw new Error("database URL/project ref mismatch");
  }
'

make_stage() {
  stage="$1"
  exclusive_max="$2"
  mkdir -p "$stage/supabase/migrations"
  cp supabase/config.toml "$stage/supabase/config.toml"
  for migration_file in supabase/migrations/*.sql; do
    migration_name="${migration_file##*/}"
    migration_version="${migration_name%%_*}"
    if [[ "$migration_version" < "$exclusive_max" ]]; then
      cp "$migration_file" "$stage/supabase/migrations/$migration_name"
    fi
  done
}

stage_a="$(mktemp -d)"  # through 123000
stage_b="$(mktemp -d)"  # through 124000 only
stage_c="$(mktemp -d)"  # through 125000
make_stage "$stage_a" '20260721124000'
make_stage "$stage_b" '20260721124500'
make_stage "$stage_c" '20260721130000'

npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_a" --dry-run
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_a" --yes

# Pause webhook delivery, then apply the forward-only identity boundary.
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_b" --dry-run
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_b" --yes

# Run reconciliation + both hard gates before this step.
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_c" --dry-run
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --workdir "$stage_c" --yes

# HARD STOP: do not run either command below unless checkout and webhook
# delivery are still paused and the full final dry-run was reviewed. Deploy
# and probe the method-aware webhook only after this push succeeds.
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --dry-run
npx --yes "supabase@${SUPABASE_CLI_VERSION}" db push \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL" --yes

npx --yes "supabase@${SUPABASE_CLI_VERSION}" migration list \
  --db-url "$SOLIDGATE_PRODUCTION_DB_URL"
```

The four dry runs must show, respectively: through `123000`; only `124000`;
only `124500` + `125000`; and only `130000` + `140620` + `195840` +
`22084816`. Keep all traffic paused through the final push, then deploy and
probe the final webhook/Funnel/PWA revisions before resuming anything. Stop on
any surprise. Retain the staged directory paths and dry-run output with
cutover evidence.

## 6. Operational checks

- Webhook endpoint subscribes to `card_gate.order.updated`,
  `alt_gate.order.updated`, `subscription.updated.v2`, and
  `card_gate.chargeback.received`.
- Raw-body signature verification happens before JSON parsing. Successful
  delivery returns 2xx promptly; failed claim-fenced work returns retryable 5xx.
- `solidgate_fulfillment_outbox`, `solidgate_subscription_token_sync_jobs`, and
  webhook claim rows have no stuck/failed backlog before widening traffic.
- Existing unresolved account-vault legacy tokens are hidden from one-click
  reads. A hosted form or exact reconciled session source replaces them; do not
  make them usable by editing the marker.
- Access is restored only by a successful paid lifecycle event, never merely by
  updating a card token.

## 7. Rollback policy

Before `124000`, normal application rollback is available. After `124000`, do
not restore old app/webhook binaries and do not use migration-history repair as
a rollback. Keep traffic paused, fix forward, and allow Solidgate to retry the
same signed events/order ids. Database ledger rows are never deleted to force a
retry.
