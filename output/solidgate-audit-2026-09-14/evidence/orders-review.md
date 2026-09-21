# Solidgate orders/accounting audit — 2026-09-14

Scope: current dirty working tree, audit only. No payment calls, external APIs, real DB mutations or separately billed operations. Reused the existing fake Supabase query builder, manually carried each successful write into the next event's fixture, and blocked all network with a throwing fetch stub. Six desired-behavior regressions fail on the current code. Reproducer: `/tmp/solidgate-orders-audit.test.ts`; captured output: `/tmp/solidgate-orders-audit-tests.txt`. To rerun, copy the test into `supabase/functions/solidgate-webhooks/__tests__/orders-audit.tmp.test.ts` and run from apps/funnel: `../../node_modules/.bin/vitest run -c vitest.config.mts ../../supabase/functions/solidgate-webhooks/__tests__/orders-audit.tmp.test.ts`. Temporary in-repo test was removed; no pre-existing changes touched.

## O1 — P1 — cumulative refunds can go backwards and inflate net revenue

Locations: `supabase/functions/solidgate-webhooks/index.ts:2323` (initial orders), `:2158` / `:2177` (renewals), `supabase/migrations/00001_baseline.sql:2686` (equal timestamps are accepted).

Sequence: captured 1767; refund callback with cumulative 1000; then older cumulative 500 callback with the SAME provider timestamp and distinct event ID. Entity ordering deliberately accepts equal timestamps. Second handler writes refunded500/net1267 instead of preserving refunded1000/net767. Reproducer test 1 fails exactly with these values. Same assignment pattern exists for renewal_events and solidgate_invoice_orders. A later exact redelivery does not help once both events are marked complete.

Consequence: one payment's actual refunds regress, internal net and customer summaries overstate money. Idempotent event IDs do not make domain state monotonic.

Fix: atomic DB refund reducer keyed by environment+provider order/invoice; lock source row and use cumulative `GREATEST(stored_refunded, incoming_refunded)` with bounded actual capture. Compute net/status and append immutable refund delta/outbox in the same transaction. Equal timestamps still need processing for auth/settle, so changing globally to <= would lose legitimate transitions.

## O2 — P1 — late settlement after first partial refund overwrites net with gross

Locations: `index.ts:2328` (partial refund leaves pending status), `:2643`–`:2658` (settlement CAS checks only pending/failed and writes paidAmount), `00001_baseline.sql:6407`–`:6408` (initial grant rejects refunds).

Sequence: initial order pending1767; partial refund500 callback arrives before first settlement callback, writes net1267/refunded500 and leaves statuspending; late same-second settle1767 event passes entity ordering and pending CAS, writes amount1767/status trialing while refunded500 remains. Reproducer test 6 fails: expected1267, actual1767. There is no orders CHECK enforcing captured-refunded-disputed net conservation. SQL main grant then returns false because refunded !=0; this downstream grant consequence is verified by reading the RPC, not by live DB execution.

Consequence: inflated durable money and a buyer with remaining paid money can remain without an initial entitlement. Retry sees the nonzero refund and stops capture recovery, leaving corruption unhealed.

Fix: make settlement and refund reducers share one row lock/financial state transition; settlement must preserve cumulative reversals and not reset net to bound original price. Separate capture proof from first entitlement eligibility and reconcile refunds that arrive before the original capture event.

## O3 — P1 — refund handler restores money already removed by a chargeback

Locations: `index.ts:2321`–`:2335` (orders), `:2168`–`:2181` (renewals), `:4256`–`:4268` / `:4373`–`:4397` (chargeback net calculation).

Sequence: initial1767 fully charged back => net0/statusdisputed; refund500 callback arrives => net1267 while chargeback1767 still recorded. Reproducer test 2 fails actual1267 vs0. More visibly, renewal5900 fully charged back, refund1200 => renewal_events net4700/statuspartially_refunded even though chargeback5900 still in_progress. Reproducer test5 fails with those values. A delayed refund callback or newer refund snapshot can coexist with an open dispute.

Consequence: internal money is created without a chargeback reversal; renewal revenue dashboard counts4700 because it sums ledger net without filtering status. Initial orders retain disputed status but their money columns are contradictory.

Fix: one financial reducer must combine actual captured total, cumulative refund and current chargeback/reversal state. Refunds must preserve open dispute status and funds-at-risk. Do not treat every event as owning net independently; keep cash movements/chargeback flows separately for correct overlapping refund+dispute accounting.

## O4 — P2 — undercaptured money is not recorded; a full refund of that capture becomes partial

Locations: `index.ts:2512`–`:2543`, `:2321`–`:2326`; current test `__tests__/webhook.test.ts:3283` explicitly expects no revenue for undercapture. Orders' `solidgate_original_amount_cents` is immutable quoted amount (baseline:1526ff), not independent captured total.

Sequence: quoted1767, provider successful settle transaction1200 and statuspartial_settled. Handler persists only provider status, leaves amount1767/pending and no captured1200 projection. Then provider refunds all1200 actually taken. Handler uses original1767 as gross and records net567, no refunded terminal status. Reproducer test4 uses the supported transaction map, not the optional/nonstandard settled_amount field; actual567 vs0.

Consequence: DB cannot answer how much was actually charged in a partial capture without raw-payload reprocessing; refunded balances are objectively wrong. Not granting full product access on undercapture is sensible, but financial recording must be independent.

Fix: add immutable quoted amount plus monotonic captured total; persist verified partial settlements and individual provider transaction IDs/timestamps even when entitlement policy refuses access. Refund classification uses actual capture, not order authorization/price.

## O5 — P2 — failed refund outbox enqueue permanently loses the refund delta

Locations: `index.ts:2325`–`:2345` then `:2356`–`:2375`; analogous renewal mapping first at`:2159`–`:2163`, outbox at`:2189`–`:2203`; outbox insert uses ignoreDuplicates at`:328`.

Sequence: refund500 updates orders successfully; analytics outbox INSERT fails (or process dies between operations). Retry reads already-refunded500 and computes delta max(0,500-500)=0, successfully inserts the original refund event key with revenue0/refund_amount0. Reproducer test3 injects an outbox failure and obtains exactly0 instead of-500. Internal order balance is correct in this case but durable analytics accounting is not; provider redelivery cannot repair it afterward.

Fix: compute and persist the refund movement and outbox payload in the same DB transaction as the refund cumulative state. EventID/operationID unique key plus immutable original delta must survive retries. The same transaction should update renewal mapping and renewal_events.

## Additional query correctness issue — P2, not yet independently unit-reproduced

`apps/funnel/src/app/admin/_queries/revenue.ts:26`–`:29` excludes every disputed initial/one-time order. Handler assigns net gross-max(refund,chargeback) at `index.ts:4256`–`:4266`. Thus a1767 payment with partial chargeback500 retains1267 in internal net but contributes0 to admin initial revenue. Renewal revenue sums all net rows (same file:45ff), so the exact equivalent recurring payment contributes1267. If these functions are intended as collected net revenue, they disagree. Root can incorporate into admin review. Fix revenue calculation independent of entitlement/current lifecycle status, using confirmed cash movements or confirmed captured net.

## Strengths inspected

- Orders unique `(payment_environment, solidgate_order_id)` and unique environment+subscription ID (`00001_baseline.sql:546`–`:552`). Invoice ledger full unique environment+invoice, and partial unique environment+order (:693–:697). No obvious ordinary redelivery duplicates in these keys.
- OTO one-live-order per environment/session/step enforced at unique-index level (:569–:584), with zero terminal declines allowing retry. Main/PWA/OTO openers use row/advisory locks and persisted checkout state. Checkout identities and original quoted amounts are immutable in DB triggers.
- Orders RLS permits only owned-row SELECT; no client write policies. Renewal, invoice, webhook/outbox tables explicitly revoke anon/authenticated privileges. Public RPCs are revoked from PUBLIC/anon/authenticated and only selected wrappers granted service_role (:9511ff). Internal grants are checked inside SQL.
- Positive initial settlement binding verifies provider order ID, metadata, stored customer/email, product/subscription, currency, exact expected amount before grant. Partial authorization is not confused with full capture. Entitlement revocation and same-order replay guards exist.
- Webhook dedupe uses environment+event ID with fenced claims; equal timestamp handling avoids lost auth->settle transitions. Those protections do not resolve the financial reducer failures above.

## Coverage limits

No claim about actual production duplicate counts, actual charged users, live deployed schema, or webhook configuration: no production read connection was used in this subaudit. No DB tests run by this agent (root owns shared DB verification). The original fake Supabase builder records writes but does not mutate tables or run constraints; test sequences explicitly carry committed writes forward, and SQL predicates/triggers were reviewed to confirm their effects. Existing tests focus on access conservation and independent events; missing financial conservation/property tests and crash-between-writes tests allow the six demonstrated scenarios.

## Deployed handler equivalence (local artifact supplied by root)

Read `/tmp/solidgate-live-webhook-index.ts` (root identifies deployed v25, 2026-08-24); no production API called by this agent. All six repro paths use equivalent logic in that deployed source: initial refund at2418–2440, recurring refund2160/2179, partial capture2616–2638, pending/failed settlement2743ff, initial chargeback4373ff. These are code-path findings present in both current boilerplate and deployed handler; this does not prove any specific live payment has suffered them. Root's live DB audit owns actual counts/anomalies.

## Bounded reporting proof (additional root request)

Executed the actual `revenue.ts` via local TypeScript transpilation with injected fake Supabase client and identity EUR conversion. Harness `/tmp/solidgate-reporting-audit.cjs`; no repo edits, network or live database calls. Five observations, all P2 (reporting correctness, not a claim that the customer was incorrectly charged):

1. **Silent truncation beyond API max rows.** `revenue.ts:23`–`:30` and`:40`–`:45` fetch rows once and reduce in JS, with no range pagination/count or SQL aggregate. Repository `supabase/config.toml:18` configures1000 rows. A1100-order×100-cent result returns100000 vs110000. Same bug affects initial totals, per-currency totals, renewal totals and chart; live deployment row cap has not been independently established by this subagent. Fix SQL SUM/grouping RPC or deterministic complete pagination with errors if incomplete.
2. **KPI Revenue excludes every renewal.** `KpiCardsRow.tsx:50`–`:52` calls `grossRevenueInEurInRange`; label at`:70` saysRevenue(EUR). Helper `revenue.ts:53`–`:55` only reads orders. Renewal-only5900 period yields KPI0, while renewal tab helper returns5900. RevenueTab explicitly separates one-time/renewal correctly; main KPI is the mismatch. Fix combined collected revenue helper (and separate gross/net definitions).
3. **Invoice-created date is reported as cash-collected date.** Webhook `index.ts:3831` puts invoice_created_at into ledger.created_at; `revenue.ts:87`–`:88` buckets onlycreated_at. Invoice Sep2 settledSep10 is graphedSep2. Initial order charts likewise use checkout-created time, not captured time. Fix separate invoice_created_at/captured_at/paid_at, with current reporting purpose explicit.
4. **Refunds rewrite past days instead of recording current negative cash movement.** `index.ts:2333` and`:2179` mutate net amounts; chart `revenue.ts:87`–`:88` uses originalcreated_at. Sep2 capture5900 then Sep14 refund1200 changes Sep2 total5900→4700 and creates no Sep14 negative movement. It is possible to call this a cohort-net view, but the existing revenue chart is not a transaction/cashflow ledger and cannot answer when money moved. Fix immutable payment/refund/chargeback movements with provider occurrence times, derive cashflow and cohort net separately.
5. **Partial disputes count differently for initial vs renewal payments.** `revenue.ts:27` excludesdisputed, but `fetchRenewals`:40–45 has no corresponding filter. Equivalent net1267 on a partially charged-back original payment contributes0; recurring counterpart contributes1267. Handler explicitly stores remaining net after partialchargeback (`index.ts:4256`ff). Fix sums based on confirmed economic net, with entitlement/lifecycle status excluded from financial truth.
