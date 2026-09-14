# Solidgate renewal/lifecycle audit — current working tree

Scope: `supabase/functions/solidgate-webhooks/index.ts`, subscription/invoice/entitlement schema and RPCs in `supabase/migrations/00001_baseline.sql`, existing renewal SQL and webhook tests. No production files edited. No remote DB/API calls. Existing user changes preserved.

Test evidence: `/tmp/solidgate-renewals-audit/renewals-audit.test.ts` is an isolated copy of the existing webhook test helper/imports plus eight new expected-invariant tests. `/tmp/solidgate-renewals-audit/result.txt` records **8 failed expected-invariant tests, 223 existing tests skipped**. These are reproductions of undesired behavior, not failures of the original existing suite. Tests call real current `handleEvent`, using the repository's mocked Supabase/write-spy helper (not a real database). Run:

```
node node_modules/vitest/vitest.mjs run --config /tmp/solidgate-renewals-audit/vitest.config.mts -t AUDIT
```

## R1 — P1: financial history depends on current entitlement state and callback arrival order

Locations: `index.ts:1002-1005`, `:3538-3542`, `:3565-3576`, `:3809-3813`, `:3933`, `:3949`.

Two concrete variants of the same ledger/access coupling:

1. Original subscription order already canceled, fully refunded/disputed, or replaced by a newer entitlement. A valid paid renewal for that original subscription arrives. `assertInitialSubscriptionCardFinalized` returns `ignore_terminal`; `handleSubscription` returns before `recordSubscriptionInvoices`. The real charge gets no `renewal_events` or invoice-order row and no paid analytics. Our test uses canceled original + successful term1/5900: zero ledger inserts.
2. A later `pause`/`payment_attempt`/other observational callback overtakes a renewal and includes its successful invoice. Recording only recognizes the hardcoded renewal callback set and special cases `order_update`/`scheduled_for_cancellation`. Pause records the mapping, not the paid invoice. Entity watermark then regards the earlier renew as stale and skips its entire handler. Test: pause with successful term1/5900 produces zero renewal rows. The code's watermark path then explains permanent projection loss.

Raw payload remains in `solidgate_webhook_events`; it is not lost from the raw inbox, but the business projection treats it completed and has no demonstrated automatic replay/reconciliation for this case. Revenue and conversion reporting miss the money.

Fix: record immutable financial facts per invoice independently of subscription entitlement ownership and current lifecycle status. Apply per-subscription chronology only to the current state/access projection, never to discovering previously unseen paid invoices. Retain current terminal-access protections.

## R2 — P1: refunded renewal can reappear as fully paid, and paid callbacks ignore reversal evidence

Locations: `index.ts:2157-2188`, `:3685-3715`, `:3816-3833`, `:3918-3921`, `:4017-4025`, `:4058-4070`.

A realistic sequence exists without concurrency:

- An observational subscription callback writes the generated order mapping while payment is processing.
- The card refund event arrives; its mapping becomes `refunded`, 5900. `renewal_events` does not yet exist, so the handler records no renewal balance.
- The successful `renew` subscription delivery arrives late. The reversal guard only applies to `isPaidRenewalSnapshot` (`order_update`/`scheduled_for_cancellation`), not actual renew/active/restore/recurring callbacks. `recordSubscriptionInvoices` inserts `status: paid, amount_cents:5900, refunded_amount_cents:0` despite durable full refund evidence.

Reproduction seeds exactly that durable refunded mapping: actual paid insertion is 5900/refund0. A second reproduction seeds an already-refunded renewal and confirms the handler still calls the active/full entitlement RPC for the refunded period (the ledger upsert itself would correctly ignore an existing row). The refund handler also does not revoke recurring access, so the missing guard is not neutralized by a tombstone.

The two handlers use separate entity locks (`payment:<order>` vs `subscription:<sub>`), and financial read/update sequences are not atomic, so concurrent interleavings can reach the same inconsistency.

Fix: merge payment/refund/dispute facts under one transaction/lock per environment+invoice; materialize net from durable reversal evidence before paid insertion; never erase accumulated reversal fields. Use the same validated invoice state for every positive callback's access policy. Merely copying the narrow snapshot guard to renew avoids one sequence but does not solve the race or preserve missing financial rows.

## R3 — P1: renewal chargeback without an invoice mapping is ACKed permanently

Locations: `index.ts:4355-4363`, contrasted with normal card-event retry `:2290-2304`.

A generated renewal order does not live in `orders`. If its subscription webhook/mapping has not landed (out-of-order delivery, failed projection, outage), `handleChargeback` returns at `if (!mapping) return`. `handleEvent` resolves and the outer handler marks the event complete. No dispute balance, access revocation, analytics, alert, or retry occurs. Reproduction with a known local parent subscription and unknown generated order resolves successfully; no rejection is raised.

Ordinary recurring payment callbacks explicitly request redelivery when the parent is ours but mapping is missing. The chargeback branch lacks equivalent unresolved-state handling. The chargeback type also does not model `subscription_id`; provider-envelope shape should determine which ownership hints can safely be used.

Fix: preserve as unresolved/retryable instead of silently completing until ownership/mapping is resolved, with a durable reconciliation path for callbacks lacking sufficient parent metadata. Do not mistake unrelated merchant events for owned subscriptions.

## R4 — P1/P2 depending supported product operations: legitimate canceled-subscription restore is impossible

Locations: `index.ts:3565-3576`; baseline `:2185-2195`, `:7021-7026`, `:7060-7061`; existing test `webhook.test.ts:5405`.

Parent verified official docs: `restore` is specifically emitted when restoring a canceled subscription (and when removing scheduled cancellation). Current logic treats cancellation as a permanent purchase tombstone and ignores all later nonterminal events, regardless of provider time/term. A real newer `restore` with successful positive term does not reactivate access or record its money. The additional isolated restore test fails with zero lifecycle RPC calls. SQL itself also disallows same-order tombstone clearing, so changing only TS is insufficient.

Existing tests intentionally require even newer positive events not to restore cancellation. They protect against stale replay but also enshrine the unsupported real restore behavior.

Fix: distinguish reversible lifecycle cancellation from irreversible financial/security revocations; implement a narrowly authorized provider restoration transition requiring exact subscription, newer lifecycle generation and verified billing facts. Preserve full refund/dispute and unrelated-order replay protection.

Official source supplied/verified by parent: https://docs.solidgate.com/billing/subscriptions/subscriptions-1.0/subscription-insights/subscription-events/

## R5 — P2: invoice last-modified time outranks the current paid term

Locations: `index.ts:3201-3226`, `:3916-3917`, `:4058`.

`latestInvoice` first selects max `updated_at || created_at`, using `subscription_term_number` only as a tie breaker. If an older historical invoice gets a later modification (e.g. payment/order update) and both old and current invoices appear in a subscription payload, the old invoice controls access. Reproduction: term0 expires Aug31, updated Aug31 10:00:05; term1 paid through Sep30, updated Aug31 10:00:00. A renew records both invoices but calls the lifecycle RPC with **Aug31**, not Sep30. SQL's GREATEST protects existing paid access from shortening; it does not extend an expired prior entitlement into the newly purchased month. Dunning recovery deliberately does not use GREATEST and can replace grace with the expired old period.

Fix: choose the highest authoritative paid billing term/current provider billing period for access; treat historical invoice modification time separately. Add a multi-invoice historical-update case to tests. Provider payloads containing multiple invoices are already modeled and looped over by this implementation; whether the provider includes the specific historic-update combination remains a contract verification item.

## R6 — P2 contract hardening: absent term can duplicate initial revenue

Locations: `index.ts:3775`, `:3809-3813`, `:3821-3826`.

`term = subscription_term_number ?? null`; `term !== 0` accepts null as renewal. The direct subscription-ID lookup bypasses the strict initial binding checks. A bound initial `active` callback missing the term field records its initial order in both `orders` and `renewal_events`. Reproduction removes only term from existing valid initial fixture: one renewal row is inserted. Original invoice/order unique indexes cannot prevent cross-table double counting.

Treat as payload-contract hardening unless current Solidgate docs allow missing term: require safe integer term >0, verify renewal order differs from the original, fail/report incomplete evidence. Do not claim a known live-provider occurrence.

## Data-model/reporting gaps (parent owns final reporting)

- No persistent subscription state table or standalone invoice table exists. Parsed `started_at`, `next_charge_at`, `cancelled_at`, trial flag, billing period start/end are not projected into relational billing history. `entitlements.expires_at` is only the current access deadline and may contain grace, not paid period.
- `renewal_events` stores invoice creation/event timestamps, not first successful capture time, billing period start/end, user/order FK, or subscription trial boundaries. Setting `created_at = invoice.created_at` attributes a late successful dunning payment to invoice issue time rather than actual cash collection time.
- `solidgate_invoice_orders` uses `ignoreDuplicates:true` for every subscription snapshot (`index.ts:3801`), so early created/processing status/metadata/amount does not update from later successful subscription snapshots. Card callbacks may repair status but only if delivered/recognized; their generic success handler updates status, not amount/metadata. The table is a first-seen snapshot rather than a reliable mirror.
- `paidConversionsRolling` uses mutable `orders.updated_at` and current status; cohort conversion excludes now-canceled subscribers who previously paid. Parent reviewing admin report correctness separately.

## Strengths verified by code/test inspection

- `renewal_events` has full unique `(payment_environment,solidgate_invoice_id)` index compatible with PostgREST ON CONFLICT; non-null invoice constraint; optional unique generated order per environment. Duplicate exact renewal deliveries are deduped.
- Initial term0 normally excluded from renewal revenue; initial card settlement/immutable ownership must be durable before lifecycle grants.
- Same-invoice paid renewal outranks same-time dunning; replayed dunning does not continuously extend grace.
- RPC uses exact environment/order/user/subscription/product ownership and row locks; newer purchase ownership and terminal reversals cannot be overwritten by older source.
- Paid period expiry follows provider invoice period; bounded cadence fallback; active-to-active SQL preserves longer paid expiry and full access, while dunning recovery replaces grace with paid expiry.
- Weekly addon dunning is recoverable past_due without an irreversible revoked tombstone, and successful renew restores it.
- Raw inbox plus durable analytics outbox make investigation/replay possible, but do not alone guarantee correct business projections.

## Recommended test expansion

Real DB-backed sequential/permutation tests should cover: paid->refund and refund->paid mapping order; invoice creation->processing->settled->refunded; payment/subscription concurrency with separate entity locks; cancel/pause overtaking unseen paid invoice; genuine restore; multiple invoices with historical updated_at; unknown chargeback then delayed mapping; missing term fail-closed; cash captured after invoice issue across reporting windows. Existing SQL renewal suite exercises grant RPC state/ownership, not webhook multi-table transactional money projection. Existing TS DB helper records writes without enforcing constraints or mutating tables, so it cannot establish end-to-end retry/concurrency correctness by itself.
