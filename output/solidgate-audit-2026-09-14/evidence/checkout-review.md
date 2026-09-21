# Solidgate checkout and payment routes audit — 2026-09-14

Read-only source audit of current dirty working tree. No provider/auth/admin API calls; no billed calls; no production edits. Source-transpiled mocked proofs live under /tmp. Other agents cover central webhook and SQL accounting in detail.

## P0 — Checkout email is sufficient to log a browser into an existing auth account

**Evidence**: `apps/funnel/src/lib/payment/provision-account.ts:64-95`, invoked by `apps/funnel/src/app/api/solidgate/grant/route.ts:1441-1448`; arbitrary email enters `apps/funnel/src/app/api/session/persist/route.ts:70-71`. The helper accepts createUser `email_exists`, generates a magic link for checkout email and directly redeems its token via the requesting browser's SSR auth client. There is no inbox challenge or match against existing authenticated browser identity.

**Concrete trigger**: target already has an auth account but has no historical main entitlement in this payment environment (otherwise create-session's intro guard rejects). Attacker creates their own funnel session using target email, completes own-card paid intro or eligible free zero-auth intro, then grants it. The victim email's account is logged in on attacker browser. If sandbox shares the auth directory but has environment-isolated entitlements, the production entitlement is not a blocker in sandbox. The latter is deployment-conditional; source does not establish deployed topology.

**Proof**: `node /tmp/solidgate-checkout-local-proof.cjs` runs the actual transpiled helper against auth stubs: existing-account createUser error, generateLink victim identity, verifyOtp server-created token, returns `{linked:true,userId:victim,isNewUser:false}`. No real account was attacked.

**Fix**: separate payment attribution/provisioning from authentication. Existing accounts need already-verified same-user auth or an OTP/magic link delivered to and redeemed from their inbox. Do not use payment confirmation to mark email verified. The payment/OTO cookie can keep purchased-session navigation independent of login.

## P1 — Card update says success on HTTP 202 and stops the only reconciliation loop

**Evidence**: `apps/pwa/src/app/[locale]/(app)/billing/update-payment/_components/SolidgateUpdateCard.tsx:36-37` returns on `response.ok`; Fetch sets `ok=true` for HTTP202. Lines146/179 then redirect to `/dashboard?payment_updated=1`. Route `apps/pwa/src/app/api/solidgate/billing/update-card/route.ts:142-146` deliberately returns HTTP202 with `{ok:false,pending:true}` on processing, no token yet, busy lease, and retryable vault persistence (e.g. lines388,443-444,494-500).

**Concrete trigger**: SDK/3DS return precedes final provider auth/token, or vault write needs retry. First confirm request responds pending202. Browser leaves as though card updated; the attempt may still be issued/applying and old card stays in use. Subscription renewals continue to fail.

**Why existing test misses it**: `.../SolidgateUpdateCard.test.tsx:91-116` fakes `{ok:false,status:202}` — an impossible native Response combination. With native Response the current regression test's intended second request never happens.

**Proof**: `node /tmp/solidgate-card-update-pending-proof.cjs` transpiles actual component source and calls exported confirmReturnedCardUpdate using native `Response.json({ok:false,pending:true,...},{status:202})`. It resolves after one fetch, with no final200. Output confirms `actualFetch202Ok:true, fetchCalls:1, returnedWithoutFinal200:true`.

**Recovery gap aggravates impact**: card updates persist in `solidgate_card_update_attempts`, not `orders`; no card_update handling exists anywhere in webhook/worker. `supabase/functions/solidgate-webhooks/index.ts:2290-2307` ignores absent non-subscription card orders as not ours. Only this browser API calls card-update claim/complete RPCs. Thus no autonomous backstop will finish if buyer leaves before successful confirmation, including this erroneous 202 redirect.

**Fix**: only resolve when final application payload says `data.ok===true` (and status is not202); retain and retry202. Use real Response objects in tests; test pending→success, pending→terminal, processing-no-token, vault retry. Add durable server reconciliation for issued/applying card-update attempts so closing tab cannot strand a valid token update.

## P1/P2 — Expired and dunning add-on purchases falsely return alreadyOwned; recovery UI excludes add-on

**Evidence**: PWA purchase `apps/pwa/src/app/api/solidgate/purchase/route.ts:713-724` considers any entitlement with revoked_at null owned. It checks neither status nor expires_at. `packages/shared/src/entitlements.ts:113-124` denies access for expired or non-grace past_due entitlement. Renewal auditor confirms add-on dunning writes past_due with revoked_at null. `packages/shared/src/grace-period.ts:49-69` excludes add-ons and requires live main grace; update-payment page lines29-31 redirects away if no such grace exists.

**Trigger**: weekly add-on renewal fails; entitlement remains past_due, revoked_at null, expired. Add-on paywall's purchase attempt returns `{ok:true,alreadyOwned:true}` without opening or charging anything, while access checks keep it locked. Main-grace-only card-update page cannot help if user's main subscription is healthy/lifetime. Similarly an active but naturally expired add-on row returns owned.

**Proof**: `/tmp/solidgate-checkout-local-proof.cjs` executes actual PWA POST with expired-active and expired-past_due fixtures. Both return200 alreadyOwned and never call opener. Printed query constraints show only environment/user/product/revoked-null.

**Fix**: use explicit active-access vs billable-past_due vs terminal-subscription states. Route past_due into card update for the EXISTING subscription. Do not naively remove ownership guard and start another subscription while the old one can still retry. Make card recovery UI available to billable add-on subscriptions; permit new purchase only after old subscription is definitively terminal.

## P1/P2 — Main app access ignores missing/expired entitlement and fails open on DB errors

**Evidence**: `packages/shared/src/entitlements.ts:176-180` returns active on read error; expired active/past_due rows and no rows map to none (186,201). PWA app layout only blocks revoked (`apps/pwa/src/app/[locale]/(app)/layout.tsx:39-45`). Accordingly login alone with zero purchases, or an expired trial/grace with no final cancel tombstone, enters app. This is intentional in comments but undermines paid access outside a bounded provisioning/renewal window.

**Fix**: bounded provisioning/reconciliation states, explicit time budget; expired/no-access blocks protected content after budget. Preserve separately accessible login and billing recovery routes. Root agent is already reviewing this known finding.

## P2 — Fresh checkout silently charges EN/USD when displayed locale disabled

**Evidence**: create-session `:340-357` defaults enabled locales to en and silently changes a new non-enabled locale to en; offer-sales-body `:46-54` displays current requested locale's initial and recurring amounts. charge-oto `:1139-1140` returns to actual session locale, so same journey can switch currency. Both `.env.example` defaults are en. Existing immutable order retries correctly preserve quote.

**Fix**: reject disabled checkout locale before payment or resolve one server quote and display exact amount/currency/renewal terms. Do not make a content-language fallback a monetary fallback.

## P2 / consistency — Paid add-on intro still carries zero defaults in two places

**Evidence**: `charge-oto/route.ts:1448-1451` sends expectedAmount0 to subscribeSavedCard although canonical bound amount uses ADDON_TRIAL_INTRO_AMOUNTS (EUR/USD100). `features/analytics/lib/checkout-context.ts:159` also defaults subscription-initial amount to0. catalog `:338-354` documents paid add-on intro.

**Limits**: the route revalidates/reclassifies provider evidence with the correct bound amount afterwards; ordinary settle_ok is still granted and written100. Do not claim universal lost revenue/failed payments. Default analytics context can emit misleading amount0 when callers omit actual override; helper parameter is objectively inconsistent and tests should bind it to actual intro.

## Functional gap — Canceled main account has no self-service full-price resubscribe

All main checkout tiers are intro, and create-session rejects any historical main entitlement regardless revocation/expiry. PWA product allowlist excludes trial_monthly/main. restoreSubscription is defined but unused. This prevents duplicate intro subscriptions but leaves legitimate canceled/expired main customers without a full-price return path. Treat as missing functionality if desired, not proof of duplicate charges.

## Verified defensive strengths / test limits

- Server-authoritative fixed prices, canonical order IDs and immutable email/locale/price snapshots.
- Durable RPC openers allocate attempts; provider-ambiguous outcomes keep same identity; decline retries restricted to proven terminal results.
- Capture vs authorization separated; positive auth0 is rejected except bound zero trial; partial capture requires exact evidence; signed provider identity/amount/currency/product checks before grants.
- OTO spend authorization checks signed cookie/account and source-bound session vault; replay checks and compare-and-set prevent browser regression over refunds/cancellations.
- Authenticated PWA purchase/confirmation; strict card update zero-auth binding and transaction provenance; latest-source vault chronology and fenced token-sync queue.
- Separate environment keys and environment-qualified DB lookups.
- Source mocks establish route behavior, not live merchant configuration or deployed correctness. Parent coordinates full checked-in tests and SQL audit. No external billable operations were used.
