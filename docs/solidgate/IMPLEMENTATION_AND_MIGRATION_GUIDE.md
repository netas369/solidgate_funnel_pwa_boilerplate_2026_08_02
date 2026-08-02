# Solidgate implementation and migration blueprint

Status: code-verified implementation guide

Implementation baseline: repository through webhook hardening commit `eb8bbccc`, inspected 2026-07-24

Audience: engineers moving another product from Stripe to Solidgate, or building a new Solidgate payment system

This document describes the payment system that is actually implemented in this repository. It is intentionally more precise than the older migration notes: those notes record how the integration evolved, while this guide records the final contracts that the current code depends on.

The reusable lesson is that Solidgate is not a search-and-replace for Stripe. The browser form, merchant-generated order identity, subscription catalog, saved-token rules, asynchronous settlement, unordered webhooks, and entitlement ledger have to be designed as one state machine.

Document precedence for this repository:

1. current code and final database definitions;
2. this as-built/portable guide;
3. `docs/solidgate/cutover-runbook.md` for this repository’s production maintenance sequence;
4. `docs/solidgate/migration-plan.md` and `docs/solidgate/am-email.md` as historical decision records that contain superseded status notes and still-open provider questions.

## 1. What was built

The implementation supports:

- a hosted Solidgate Payment Form for the first purchase;
- paid seven-day introductory subscriptions;
- zero-amount free trials that tokenize a reusable payment method;
- multi-currency subscription products;
- Apple Pay in the hosted form;
- saved-card one-click one-time purchases;
- a second subscription started from a saved token;
- full-page 3DS recovery for token charges;
- a member-area checkout that chooses a saved token or hosted form;
- zero-amount card replacement and propagation of the new token to active subscriptions;
- inbound subscription renewals, dunning, cancellation, restoration, refunds, and chargebacks;
- provider client primitives for refund/cancel/restore, with lifetime-upgrade cancellation as the only complete outbound cancellation flow in this repository;
- durable entitlements, analytics, emails, and subscription-cancellation side effects;
- separate production and sandbox webhook ledgers.

The high-level flow is:

```text
Browser
  │
  ├─ asks server to open an immutable local payment identity
  │    └─ database atomically chooses order_id and one submitter
  │
  ├─ first payment: Solidgate hosted form
  │    └─ server encrypts a signed paymentIntent; card data never reaches us
  │
  └─ saved method: server POSTs /recurring with the vaulted token
       └─ any timeout or uncertain response is reconciled against the SAME order

Solidgate
  ├─ status API confirms the exact order for an interactive buyer
  └─ signed, unordered webhooks finalize payments and subscriptions later

Local ledger
  ├─ orders and renewal events preserve financial history
  ├─ entitlements control access
  ├─ source-fenced vaults retain reusable token provenance
  └─ outboxes deliver non-financial side effects idempotently
```

## 2. Non-negotiable invariants

Copy these invariants before copying any route or component:

1. **The server owns every amount, currency, product, email, locale, customer ID, and metadata value.** The browser may request an offer slug, but it never constructs a payment intent.
2. **`order_id` is the payment idempotency identity.** An uncertain provider call is retried by reading the same order, not by inventing another order.
3. **An attempt advances only after durable terminal evidence.** A timeout, 5xx, malformed response, `created`, `processing`, `3ds_verify`, or positive `auth_ok` is not a decline.
4. **The database opens an order before any provider submission.** It atomically chooses one builder or submitter and makes concurrent callers followers.
5. **Browser SDK events and redirect query parameters are hints, never payment truth.** Access is granted only after a server-side provider status read or a verified webhook.
6. **A positive authorization is not a capture.** Positive orders require `settle_ok` or exact captured-amount evidence. A genuine zero-amount subscription is the sole `auth_ok` exception.
7. **Provider identity must match the local snapshot exactly.** Verify order ID, owner, product, amount, currency, email, subscription, and metadata before granting anything.
8. **Vault tokens are usable only with provider-reported provenance.** Never infer Apple Pay, Google Pay, card, or network-token origin from the browser or from brand/last4.
9. **The vault is not proof of payment.** It is only a pointer to a signed source order, which must remain financially grantable.
10. **Webhooks are duplicate and out of order.** Deduplicate by event ID, ignore only events that are strictly older than the provider-time watermark, allow equal-timestamp events through domain-idempotent transitions, and fence work per provider entity.
11. **Financial state and side effects are separate.** Commit orders/entitlements first; deliver emails, analytics, and cancellation work through retryable outboxes.
12. **Refunds and disputes must block replay.** An old successful status response cannot restore access after a newer local reversal.
13. **Sandbox and production are different payment environments.** Keys, webhook ledgers, vaults, orders, entitlements, and reconciliation queries are environment-scoped.
14. **Only terminal, proven failure opens attempt N+1.** Never turn transport ambiguity into a second possible charge.
15. **No raw card data is collected by the application.** The hosted form owns card entry, 3DS, and tokenization.

## Audit findings to fix or consciously accept before reuse

The implementation is defensive around money movement and webhook concurrency, but the audit found the following gaps. These are descriptions of current behavior, not patterns to copy.

### Critical

**Existing-account takeover through post-payment auto-login.** `linkAuthUser()` in `apps/funnel/src/lib/payment/provision-account.ts` admin-generates a magic link for the checkout email and immediately redeems its hashed token into the current browser session. The main grant route calls it after payment. If the email already belongs to an account that does not yet own the main entitlement, a buyer can enter that victim email, pay, and receive a session for the existing account without proving inbox control.

Required correction:

- never redeem an admin-generated link into the current browser for an existing user;
- require an already authenticated matching user or inbox verification;
- auto-login may be retained only for a provably new account created as part of this exact flow;
- treat payment ownership and authentication ownership as separate proofs.

### High

- **Catalog verification is incomplete.** `--verify` validates price rows, while product reuse checks only billing period. It does not prove root payment action, trial action/length, retry mode, status, descriptions, or metadata. A provider-side edit can change checkout/rebill behavior while verification passes. Expand verification to compare the full product contract.
- **Localized disclosure can diverge from the charged currency.** A missing/incomplete `ENABLED_CHECKOUT_LOCALES` silently falls back to EN/USD for main checkout, while UI copy and later upsells can still use another locale. Make enabled locales a required startup contract, bind the displayed quote to the same server snapshot, and reject rather than silently reprice.
- **Session and order IDs act as bearer capabilities in parts of the funnel.** Main create/grant routes do not require a pre-existing signed capability, and grant issues the OTO access cookie after exact-order reconciliation. UUID entropy reduces guessing but does not prevent leaked return URLs/browser state from being replayed. Bind the main flow to a secure same-site session capability before exposing charge authority.
- **Environment validation proves labels, not the actual key pair.** A sandbox key can be mistakenly stored in the production scope while labeled `production`. Add a deploy-time signed status/catalog probe against the intended channel, validate key shape/pairing, and compare expected merchant/channel identity.
- **Duplicate introductory subscriptions can require manual refund/cancellation.** Lease takeover can produce two payable provider subscriptions. The database records superseded IDs and exposes `solidgate_intro_claims_needing_refund`, but no worker resolves them. Add a durable refund/cancel workflow and an alert with a response-time objective.
- **PWA account-vault charges do not revalidate the token’s source payment.** The funnel session-vault path re-reads the exact signed source order and proves that it remains financially grantable before charging. `getAccountVault()` validates the stored account-vault shape, source ID, token, and provider-reported provenance, but the PWA purchase and advisor-trial routes can then charge it without re-reading that source order. Make source-order financial validation a shared authorization primitive and require it immediately before every token charge.

### Medium

- The SDK loader has no explicit load/mount watchdog; a CDN, CSP, or initialization failure can leave the checkout spinner indefinitely.
- The PWA form has no post-submit watchdog and does not become inert on `onSubmit`; its latch activates only when a later success/fail/error callback requests confirmation. Port the funnel’s lost-message recovery and immediate submit lock to the PWA.
- The production funnel return-origin helper can fall back to the request origin when `NEXT_PUBLIC_FUNNEL_URL` is absent. Require the configured HTTPS production origin instead.
- API calls have a hard timeout but no centralized jittered 429/5xx retry policy. Retrying a mutation still requires same-order reconciliation first.
- `scheduled_for_cancellation` emits analytics without a distinct local scheduled state, and `pause` has no dedicated access transition. `switch_product` can persist common invoice/order mappings and a successful later-term invoice can create renewal/analytics records, but there is no dedicated product/access transition. Do not enable those provider features until local semantics exist.
- There is no customer-facing Solidgate cancellation route in this repository; the cancel API is currently used by lifetime-upgrade fulfillment and otherwise relies on support/provider callbacks.
- There is no complete operator/customer refund or restoration workflow. The shared client exposes the provider calls and webhooks consume resulting lifecycle events, but no application route invokes refund or restore.
- Lifetime-upgrade fulfillment rechecks the lifetime source before the external cancellation, but not after the provider call and before local cancellation. A refund/chargeback race can still cancel the old subscription.
- A 60-day main-plan dunning grace is deliberate but financially generous. Reassess it for another product.
- The webhook signs with the configured key but does not separately enforce equality of the received `Merchant` header, and provider event timestamps have no freshness window. These are defense-in-depth gaps rather than a present signature bypass.
- Dispute alerts are best effort rather than a durable outbox effect.
- Provider product identity used for charging can differ from analytics context after a catalog rotation on an already-open checkout. Persist and emit the immutable provider IDs from the opened identity.

## 3. Source map

These are the authoritative implementation files:

| Area | Source |
|---|---|
| Product model and amounts | `packages/shared/src/solidgate/catalog.ts` |
| Provider product/price UUIDs | `packages/shared/src/solidgate/catalog-ids.json` |
| Catalog seeder | `scripts/solidgate-seed-catalog.ts` |
| API signing and verification | `packages/shared/src/solidgate/signature.ts` |
| Payment Form encryption | `packages/shared/src/solidgate/form.ts` |
| API client and environment guard | `packages/shared/src/solidgate/client.ts` |
| Merchant order grammar | `packages/shared/src/solidgate/order-id.ts` |
| Descriptor suffixes | `packages/shared/src/solidgate/descriptor.ts` |
| Token-origin policy | `packages/shared/src/solidgate/payment-method.ts` |
| Saved-token charge interpreter | `packages/shared/src/solidgate/oto.ts` |
| Session and account vaults | `packages/shared/src/solidgate/session-vault.ts`, `packages/shared/src/solidgate/account-vault.ts` |
| Subscription token propagation | `packages/shared/src/solidgate/subscription-token-sync.ts` |
| Funnel checkout | `apps/funnel/src/app/api/solidgate/create-session/route.ts` |
| Funnel confirmation/grant | `apps/funnel/src/app/api/solidgate/grant/route.ts` |
| Account creation/linking | `apps/funnel/src/lib/payment/provision-account.ts` |
| Funnel saved-token purchases | `apps/funnel/src/app/api/solidgate/charge-oto/route.ts` |
| Funnel hosted form | `apps/funnel/src/components/checkout/solidgate-checkout.tsx` |
| Member-area purchase | `apps/pwa/src/app/api/solidgate/purchase/route.ts` |
| Member-area confirmation | `apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts` |
| Member-area advisor trial | `apps/pwa/src/app/api/solidgate/advisor-trial/route.ts` |
| Card replacement | `apps/pwa/src/app/api/solidgate/billing/update-card/route.ts` |
| Member-area hosted form | `apps/pwa/src/components/solidgate/SolidgatePaymentForm.tsx` |
| Production webhook | `supabase/functions/solidgate-webhooks/index.ts` |
| Sandbox webhook wrapper | `supabase/functions/solidgate-webhooks-sandbox/index.ts` |
| Durable fulfillment | `apps/funnel/src/lib/payment/solidgate-fulfillment.ts` |
| Database contracts | Solidgate-named files under `supabase/migrations/` |
| Checked-in provider schema snapshot | `docs/solidgate/openapi/` |
| Production maintenance procedure | `docs/solidgate/cutover-runbook.md` |

## 4. Provider credentials, hosts, and cryptography

### 4.1 Credentials

Use separate pairs for separate purposes:

```dotenv
SOLIDGATE_ENVIRONMENT=sandbox
SOLIDGATE_API_PUBLIC_KEY=api_pk_...
SOLIDGATE_API_SECRET_KEY=api_sk_...
SOLIDGATE_WEBHOOK_PUBLIC_KEY=wh_pk_...
SOLIDGATE_WEBHOOK_SECRET_KEY=wh_sk_...
```

The application pair signs outbound API calls and encrypted form intents. The webhook pair verifies inbound callbacks. Do not substitute one pair for the other.

This repository binds deployment scope to payment environment:

- Vercel Production requires `SOLIDGATE_ENVIRONMENT=production`;
- Vercel Preview requires `SOLIDGATE_ENVIRONMENT=sandbox`;
- a mismatch throws before a payment route can operate.

The payment environment is also persisted on financial and vault rows. Key scope alone is not sufficient isolation.

Additional runtime values used by the complete system include:

```dotenv
NEXT_PUBLIC_FUNNEL_URL=https://...
NEXT_PUBLIC_PWA_URL=https://...
INTERNAL_API_SECRET=...
CRON_SECRET=...
SLACK_DISPUTE_WEBHOOK_URL=...       # optional
NEXT_PUBLIC_POSTHOG_KEY=...         # optional
NEXT_PUBLIC_POSTHOG_HOST=...        # optional
RESEND_API_KEY=...                  # if email fulfillment is enabled
```

The sandbox webhook uses its own `SOLIDGATE_WEBHOOK_PUBLIC_KEY_SANDBOX` and `SOLIDGATE_WEBHOOK_SECRET_KEY_SANDBOX` in the Edge Function environment. It can optionally wake a designated preview fulfillment worker using `SOLIDGATE_SANDBOX_FULFILLMENT_URL` and `SOLIDGATE_SANDBOX_FULFILLMENT_SECRET`.

### 4.2 API hosts

Solidgate v1 operations are split across hosts:

| Concern | Base URL |
|---|---|
| Card payments, status, recurring token charges, refunds | `https://pay.solidgate.com/api/v1/` |
| Billing 1.0 products and subscriptions | `https://subscriptions.solidgate.com/api/v1/` |
| Alternative payment methods | `https://gate.solidgate.com/api/v1/` |
| Reports | `https://reports.solidgate.com/api/v1/` |

Do not assume one universal base URL. A wrong host can produce a WAF response rather than a helpful 404.

### 4.3 Signature algorithm

For a JSON body string `body`:

```text
data       = publicKey + body + publicKey
digest     = HMAC-SHA512(secretKey, data)
hex        = lowercase hexadecimal text of digest
signature  = Base64(UTF-8 bytes of hex)
```

The double encoding is intentional. Do not base64-encode the raw HMAC bytes.

Send the public key and signature in `Merchant` and `Signature` headers. A bodyless GET signs `publicKey + publicKey`.

Webhook verification uses the same algorithm with the webhook key pair and the **raw request body exactly as received**. Verify the merchant header matches the configured webhook public key, compare signatures in constant time, and only then parse JSON.

### 4.4 Payment Form encryption

The server builds Payment Form `merchantData` locally; it does not create a Stripe-like PaymentIntent through an API call:

```text
plaintext   = JSON.stringify(serverOwnedPaymentIntent)
key         = first 32 ASCII characters of api_sk
iv          = 16 cryptographically random bytes
ciphertext  = AES-256-CBC(key, iv, plaintext)
intent      = Base64(iv + ciphertext), with "+"→"-" and "/"→"_"; keep "=" padding
signature   = normal Solidgate signature over the encrypted intent string
merchantData = { merchant: api_pk, paymentIntent: intent, signature }
```

The implementation uses Web Crypto and native `fetch`, so the shared code works in Node, Deno, and Edge-like runtimes. It deliberately avoids the old Node SDK HTTP layer that conflicted with Turbopack.

### 4.5 Transport behavior

The shared client applies a 12-second timeout. A timeout or broken response is an indeterminate result because the provider may have accepted the request.

Also note that a 2xx response may still contain a Solidgate `error` object. The HTTP client only handles transport status; the payment interpreter must handle decline and validation envelopes inside successful HTTP responses.

## 5. Catalog and product modeling

### 5.1 Locale is not a product dimension

The old Stripe model used many locale-specific products/prices. The Solidgate model has:

- one provider product per billing behavior or intro tier;
- one price per supported currency on that product;
- locale stored in the application and sent as `language`;
- currency selected from the application’s locale-to-currency map;
- localized product text outside the provider catalog.

The current catalog supports `EUR`, `USD`, `CZK`, `HUF`, `RON`, `TWD`, `ILS`, `PLN`, `DKK`, and `JPY`. All amounts use minor units, except that JPY amounts are already whole yen.

### 5.2 Current subscription products

| Catalog key | Checkout now | Trial | Future billing |
|---|---:|---|---|
| `trial1` | tier-specific paid intro | 7 days, `auth_settle` | regular main price every 30 days |
| `trial2` | tier-specific paid intro | 7 days, `auth_settle` | regular main price every 30 days |
| `trial3` | tier-specific paid intro | 7 days, `auth_settle` | regular main price every 30 days |
| `trial4` | tier-specific paid intro | 7 days, `auth_settle` | regular main price every 30 days |
| `special_1eur` | low paid intro | 7 days, `auth_settle` | regular main price every 30 days |
| `special_free` | zero-amount authorization | 7 days, `auth_0_amount` | regular main price every 30 days |
| `addon_trial` | zero-amount authorization | 7 days, `auth_0_amount` | advisory price every week |
| `addon_direct` | first weekly price immediately | none | advisory price every week |

The five paid main intro tiers need separate Billing 1.0 products because trial price is a product-price property. They share one internal offering code but have different intro amounts.

The two advisory products intentionally share an offering code but not provider product identity. One promises seven free days; the member-area version charges immediately. Trial behavior belongs to the provider product, so they cannot safely be the same product.

### 5.3 One-time products

Lifetime access and PDF/report upsells do **not** have provider catalog products. They are amount-based `POST /recurring` charges containing the exact server-owned amount and currency.

That distinction prevents an accidental subscription and avoids maintaining unnecessary provider products:

```text
subscription purchase → recurring_token + product_id + currency
one-time purchase      → recurring_token + amount + currency, no product_id
```

### 5.4 Seed and verify the catalog

The seeder is dry-run by default:

```bash
npx tsx scripts/solidgate-seed-catalog.ts
npx tsx scripts/solidgate-seed-catalog.ts --apply
npx tsx scripts/solidgate-seed-catalog.ts --verify
```

All three commands require the intended channel’s API key pair. `--apply` mutates that merchant catalog; confirm the resolved merchant/channel and review the dry run before using it.

Its contracts are:

- match live products through `metadata.catalog_key`;
- create recurring products with the configured billing period and smart retry mode;
- create one default EUR price and additional prices for every supported currency;
- send `trial_price` only for paid trials;
- archive and recreate a product when the billing period changes;
- refuse silent amount drift on an existing price;
- write provider product and price UUIDs to `packages/shared/src/solidgate/catalog-ids.json`;
- treat those UUIDs as identifiers, not secrets, and commit them.

As currently written, `--verify` checks the price set but not the full product/trial/retry contract. Before treating it as a launch gate, extend it to fetch and compare every behavior listed in the audit findings.

For a new project, keep the catalog definition and price map in one source of truth and test that the two cannot drift. Do not edit an active price in place unless the exact Solidgate billing version and subscription impact have been reviewed. Version or recreate products when an immutable billing promise changes.

The current implementation is Billing 1.0. `subscription.updated.v2` means the extended webhook event format; it does **not** mean the application uses Solidgate Billing 2.0.

## 6. Merchant order identity and immutable snapshots

### 6.1 Order ID grammar

The merchant order grammar is:

```text
{ownerRef}:{offeringSlug}:{attempt}
```

Examples:

```text
<funnel-session-uuid>:trial1:1
u-<application-user-uuid>:oto5_pdf:2
```

The order ID simultaneously serves as:

- the provider idempotency identity;
- the local owner/session binding;
- the reconciliation key;
- the analytics join key.

The parser requires exactly three colon-separated parts and a positive integer attempt. Both the session/user reference and offer slug must exclude colons. The provider limit is 255 characters.

If a request times out, reuse this order ID and call status. Generate attempt N+1 only after the database contains durable terminal evidence for attempt N.

### 6.2 Snapshot fields

On the first open, persist an immutable snapshot containing at least:

- payment environment;
- local database order ID;
- provider order ID;
- owner/session/user ID;
- internal offer slug and canonical product code;
- amount and lowercase currency;
- customer email;
- checkout locale;
- provider product ID and price ID, when applicable;
- payment action;
- purchase mode (`hosted_form` or `saved_card`);
- exact order metadata;
- the generated encrypted `merchantData`, for hosted forms.

Later retries load this snapshot. They do not recompute price, email, locale, attribution, or payment mode from mutable application state.

### 6.3 Atomic open and claim leases

The database RPC must atomically:

1. find or create the canonical payable order for the owner and logical step;
2. reject incompatible existing identity;
3. choose one request as form builder, provider submitter, or reconciler;
4. return all other callers as followers;
5. lease ownership with an unguessable claim token;
6. expose stored state so followers can return the same result.

This repository has separate RPC families for main checkout, funnel upsells, member-area purchases, advisor trials, and card updates. The details differ, but the claim/follower contract is the same.

## 7. Metadata

Solidgate order metadata permits up to 10 key/value pairs and up to 380 characters per value. Keep it small, stable, non-sensitive, and server-owned.

The funnel checkout writes:

```json
{
  "funnel_code": "...",
  "funnel_variant": "...",
  "session_id": "...",
  "product_slug": "trial1",
  "price_id": "...",
  "utm_source": "...",
  "utm_medium": "...",
  "utm_campaign": "...",
  "utm_content": "...",
  "utm_term": "..."
}
```

Only present UTM values are included. Locale is sent through native `language`, preserving a metadata slot.

Member-area purchases use:

```json
{
  "funnel_code": "PWA",
  "funnel_variant": "member_area",
  "session_id": "u-<user-id>",
  "product_slug": "<internal-offer-slug>",
  "price_id": "<provider-price-id for subscription>"
}
```

One-time member-area purchases use `locale` instead of `price_id`. The optional advisor trial uses `funnel_code=PWA_TRIAL`.

Do not treat metadata as the only authorization boundary. The implementation checks metadata **and** first-class provider fields against the local immutable snapshot. Do not assume initial metadata automatically propagates to provider-generated renewal orders; bind renewals through subscription, invoice, and provider order identities.

## 8. Descriptors

The channel or connector owns the base statement descriptor. The code sends a product-specific `dynamic_descriptor.suffix` only on cardholder-present Payment Form intents.

Current suffixes include:

| Offering | Suffix |
|---|---|
| Main subscription | `THEASTRO` |
| Lifetime | `LIFETIME` |
| Advisory | `ADVISORS` |
| Ultimate pack | `ULTRA PACK` |
| Soul report | `SOULREPORT` |
| Love report | `LOVEREPORT` |
| Energy guide | `ENERGY` |
| Palmistry | `PALMISTRY` |
| Tarot | `TAROT` |
| Numerology | `NUMEROLOGY` |
| Dream academy | `DREAMS` |

In the present product flow, the main/advisory hosted-form suffixes can be used, but most listed OTO suffixes are not sent because those purchases use `/recurring`. The map expresses desired cardholder labels, not proof that every label reaches a statement.

Important implementation limits:

- `/recurring` does not receive `dynamic_descriptor`; this was rejected by the sandbox request schema;
- provider-generated rebills also do not receive a new per-charge suffix from this application;
- therefore saved-token upsells and renewals may display the base descriptor or provider-specific inherited behavior;
- the final visible value can also include connector, card-brand, or PayFac prefixes and can be truncated.

The code conservatively restricts suffixes to 10 printable ASCII characters and rejects `^`. Solidgate’s current public descriptor page now documents a suffix length of up to 18. Treat this as a provider-version/channel discrepancy: revalidate the checked-in OpenAPI schema and live connector contract before changing the code.

Before launch, obtain written confirmation of:

- the exact base descriptor;
- whether each connector route is static or dynamic;
- how `/recurring` and provider renewals appear;
- brand/PayFac prefixes and the effective total length;
- truncation behavior;
- whether spaces and punctuation used by the chosen suffixes are supported.

Then make the checkout disclosure, receipt, support scripts, and chargeback monitoring use the same recognizable brand wording.

## 9. Hosted Payment Form checkout

### 9.1 Server intent

A representative first-payment intent is:

```ts
{
  order_id,
  order_description,
  dynamic_descriptor: { suffix: "THEASTRO" },
  amount,                         // minor units
  currency: currency.toUpperCase(),
  apple_pay_merchant_name: "<Your Product>",
  product_id,                     // subscription only
  product_price_id,               // exact currency price
  customer_account_id,
  customer_email,
  ip_address,
  platform: "WEB",
  language: locale,
  traffic_source,
  transaction_source,
  success_url,
  order_metadata
}
```

The funnel uses the session ID as `customer_account_id`; the member area uses the authenticated user ID. Return URLs are generated server-side. Member-area production routes require a configured trusted application origin, and all production routes require a public client IP. The funnel helper currently falls back to the request origin when `NEXT_PUBLIC_FUNNEL_URL` is absent; change that to a hard failure before reusing the design.

The first checkout passes both `product_id` and exact `product_price_id`, eliminating ambiguity in a multi-currency catalog.

### 9.2 Browser SDK

Both applications use `@solidgate/react-sdk`. The channel-specific white-label bundle is loaded once at module scope:

```ts
SdkLoader.load("https://cdn.charge-auth.com/js/form.js");
```

The hosted iframe owns:

- card number, expiry, and security code;
- tokenization;
- wallet UI;
- 3DS interaction;
- provider submission.

The application supplies styles, labels, and signed `merchantData`. It never receives raw card details.

Both forms treat SDK success/fail/error as browser claims and ask the server to reconcile the exact order. Their submit protection is not identical:

- the funnel latches and disables submission on `onSubmit`, starts a watchdog that reconciles if a later postMessage is lost, and remounts only for a genuinely new N+1 order;
- the PWA records that submission occurred, but becomes inert only when a later success/fail/error callback requests confirmation and has no lost-message watchdog;
- in both forms, a post-submit fail/error triggers reconciliation because it can race settlement;
- a pre-submit error is shown as a localized generic failure.

The funnel behavior is the portable target. Add its immediate submit lock and watchdog to the PWA before assuming equivalent double-submit/lost-message protection.

### 9.3 Interactive confirmation

The confirmation endpoint:

1. authenticates or proves session access;
2. loads the exact local order;
3. calls Solidgate `/status` for that order;
4. validates every binding;
5. classifies financial state;
6. performs a compare-and-swap finalization;
7. grants the entitlement;
8. records a source-fenced token if the signed provider transaction contains one;
9. publishes outbox work.

For a positive paid `auth_ok`, the funnel may issue a short-lived “accepted” navigation capability so the buyer can continue while capture finishes. It does not grant entitlement or mark payment complete. The exact-order webhook/status backstop remains responsible for settlement.

## 10. Apple Pay

Apple Pay is integrated through the hosted form, not through a custom host-to-host wallet implementation.

The Payment Form configuration is:

```tsx
applePayButtonParams={{ enabled: true, integrationType: "js" }}
```

The JS integration supports Apple Pay QR completion in compatible non-Safari browsers. The payment intent also supplies `apple_pay_merchant_name`.

For every production origin that renders the button:

1. place Solidgate/Apple’s exact verification artifact at `/.well-known/apple-developer-merchantid-domain-association`;
2. serve it over HTTPS without authentication;
3. serve it as `text/plain`;
4. register and verify the exact domain in Solidgate Hub;
5. have the required Apple Pay certificates/channel capability enabled;
6. verify both the iframe origin and top-level origin when applicable;
7. test Safari and the JS/QR path outside Safari.

This repository carries the verification file in both application `public/.well-known/` directories and adds an explicit `Content-Type: text/plain` header in both Next.js configs.

If the application has a CSP, allow at least the hosts required by the active form and wallet configuration. The funnel currently allows:

- `cdn.charge-auth.com` for the SDK;
- `*.charge-auth.com` and `*.solidgate.com` for form, API, and 3DS frames/connections;
- `applepay.cdn-apple.com` in `script-src`, `img-src`, and `frame-src`;
- the application’s own return origins in `frame-src`;
- the Solidgate form origins in `frame-ancestors` so a 3DS return can render.

Do not add a broad `X-Frame-Options: DENY`; it conflicts with the controlled iframe return flow. Use a reviewed CSP `frame-ancestors` allowlist.

Google Pay is intentionally disabled in the current form until its merchant ID, provider channel, domain verification, and CSP are complete. All unused APM buttons are explicitly disabled rather than relying on provider defaults.

## 11. Saved tokens, Apple Pay provenance, and rebilling

### 11.1 Capture and store provenance

The reusable token comes from signed provider status/webhook data:

```text
transaction.card_token.token
transaction.card_token.original_payment_method
```

Recognized origins are:

- `card`;
- `network-token`;
- `apple-pay`;
- `google-pay`;
- `click-to-pay`.

The application maps them to:

| Original method | Local saved-token action |
|---|---|
| `card` | `payment_type: "1-click"` |
| `network-token` | `payment_type: "1-click"` |
| `apple-pay` | `payment_type: "rebill"` |
| `google-pay` | `payment_type: "rebill"` |
| `click-to-pay` | fail closed; do not reuse |
| missing, unknown, or conflicting | fail closed; collect a new method |

The wallet mapping is based on merchant-specific written Solidgate Support guidance received for this channel. It is **not a universally portable default**. Public Solidgate guidance says wallet-derived tokens are MIT-only and customer-present one-click purchases should re-display the wallet. A new project must obtain its own approval and mandate language; otherwise re-present Apple/Google Pay for each customer-present upsell.

Never let the client select `payment_type`.

### 11.2 Vault design

There are two vault levels:

- **session vault** for a funnel visitor before account ownership is established;
- **account vault** for authenticated member-area purchases and card updates.

Each vault row contains:

- payment environment;
- owner ID and provider customer-account ID;
- exact source kind and source database ID;
- source claim/generation information;
- token;
- display-only brand and last four digits;
- `original_payment_method`.

Sensitive vault tables are service-role-only. Client-writable session data is never trusted to carry a reusable token.

Writes are monotonic and source-fenced:

- a newer signed source advances the watermark;
- a late retry from an older source cannot overwrite it;
- a newer tokenless hosted-form capture still advances the source and hides an older token;
- promotion from session to account retains exact source chronology;
- legacy or unclassified tokens are hidden, not made usable by guessing.

The funnel session-vault authorization re-reads the vault’s exact source order and checks that it still represents a valid, non-reversed acquisition. The PWA account-vault purchase and advisor-trial paths do not currently perform that financial revalidation after `getAccountVault()`. Treat this as a gap: every saved-token authorization path in a target project must re-read and validate the exact source order immediately before charging.

### 11.3 One-time saved-token request

The one-time shape is:

```json
{
  "order_id": "...",
  "recurring_token": "...",
  "amount": 3000,
  "currency": "USD",
  "order_description": "...",
  "type": "auth",
  "settle_interval": 0,
  "payment_type": "1-click",
  "customer_account_id": "...",
  "customer_email": "...",
  "ip_address": "...",
  "platform": "WEB",
  "success_url": "...",
  "fail_url": "...",
  "order_metadata": {}
}
```

`type=auth` plus `settle_interval=0` requests immediate authorization and settlement. The route itself uses zero internal polling attempts when the surrounding database state machine and webhook own the finalization.

### 11.4 New subscription from a saved token

The product-based shape is:

```json
{
  "order_id": "...",
  "recurring_token": "...",
  "product_id": "...",
  "currency": "USD",
  "order_description": "...",
  "type": "auth",
  "settle_interval": 0,
  "payment_type": "1-click",
  "customer_account_id": "...",
  "customer_email": "...",
  "ip_address": "...",
  "platform": "WEB",
  "success_url": "...",
  "fail_url": "...",
  "order_metadata": {}
}
```

Do not send an amount. Billing behavior and price come from the provider product. **Do send currency.** The implementation verified that omitting it can select the product’s default EUR price for a non-EUR buyer.

### 11.5 Token-charge outcomes

Interpret provider state conservatively:

| Provider evidence | Decision |
|---|---|
| `created`, `processing`, `3ds_verify` | pending |
| positive `auth_ok` | pending/accepted, never paid |
| zero `auth_ok` + exact zero amount + expected subscription ID | successful zero-amount subscription authorization |
| `settle_ok` + exact order amount | captured |
| `partial_settled` + exact sum of successful settle transactions | captured |
| `partial_settled` without exact capture proof | pending |
| `auth_failed`, `declined`, `void_ok` with consistent zero-net evidence | terminal failure |
| request-level error with no provider order | definite rejected request |
| timeout, malformed body, conflicting evidence | pending and reconcile same order |

Some recurring responses contain a 3DS `verify_url` while the nested order is still `created` or `processing`. That URL is actionable on the immediate submission response. On a later status read, only an explicit `3ds_verify` state may resurrect a stored challenge URL.

`verify_url` and the compatibility alias `verify_link` are accepted only when they agree. A redirect URL must be HTTPS and must not contain credentials. Token-charge 3DS is a full-page redirect; both return outcomes point to the same exact-order confirmation route, which reads provider state instead of trusting the URL.

## 12. Funnel checkout and upsell flow

### 12.1 Main checkout

`create-session` performs:

1. product allowlist validation;
2. session UUID and database existence checks;
3. immutable email, locale, price, product, and attribution binding;
4. production public-IP enforcement;
5. fail-closed introductory-offer eligibility;
6. a merchant-wide email-hash claim so concurrent sessions cannot consume multiple intro tiers;
7. provider product/price lookup from the committed catalog;
8. atomic main-order open;
9. local encryption of merchant data;
10. atomic publication of that exact merchant data.

All main tiers serialize through the canonical main offering, not merely the requested tier. This prevents a buyer from racing two different intro products.

### 12.2 Grant

The grant route never trusts the form callback. It:

- reads provider status once per request;
- validates exact order, session, price, product, amount, currency, email, metadata, and subscription binding;
- records positive authorization as accepted-only;
- grants on exact capture or a valid zero-amount subscription authorization;
- writes the source-fenced session vault;
- consumes the introductory claim;
- resolves or creates the user and links ownership;
- promotes the token to the account vault;
- grants entitlement atomically;
- emits acquisition, analytics, email, and fulfillment work;
- drains pending subscription-token synchronization work;
- refuses replay after refund, void, dispute, or revocation.

The financial binding in this route is strong, but its downstream account linker currently has the critical existing-account auto-login issue documented above. Do not use a payment-bound email as proof of control over a pre-existing authentication identity.

### 12.3 Upsell chain

One generic charge route handles every upsell. It:

- proves session ownership through an HMAC payment-access cookie tied to the exact main order, or through an authenticated owning account;
- validates sequential upsell progress;
- obtains the source-bound reusable token;
- atomically opens one payable order per logical upsell step;
- uses amount-based `/recurring` for one-time products;
- uses product-based `/recurring` for the advisory subscription;
- records accepted/pending/3DS/terminal results under a claim token;
- advances the funnel only after provider-accepted state;
- grants only after exact financial success;
- leaves fulfillment to a durable outbox.

OTO step 3 contains several mutually exclusive products and is serialized as one logical step. Model mutually exclusive variants by business step, not just SKU.

The payment-method display endpoint reads only brand/last4 from the local vault. It does not call the provider on every page render.

## 13. Member-area flows

### 13.1 Purchase

The member-area purchase endpoint chooses its mode once:

- use the account vault when a token and supported provenance exist;
- otherwise create a hosted form;
- `forceForm` can request a new form, but an already-opened immutable identity keeps its original mode.

One-time library items use amount-based charging. The direct advisory purchase uses the no-trial provider product and charges the first week immediately.

The confirmation endpoint is the only browser-request path that grants. It authenticates the user, verifies the canonical `u-{userId}` order grammar, re-reads Solidgate status, performs exact amount/product/subscription checks, guards against concurrent webhook reversal, finalizes via compare-and-swap, grants the entitlement, and vaults a hosted-form token with source chronology.

The return component performs bounded retries after 3DS. It keeps the return parameter when state remains ambiguous so the buyer can recover later.

### 13.2 Optional advisor trial

The member-area advisor trial is feature-gated. It:

- enforces one trial per user atomically;
- uses the `addon_trial` catalog product;
- performs a zero-amount hosted form or saved-token authorization;
- requires an exact subscription ID and zero amount;
- grants a seven-day trial entitlement;
- relies on the existing webhook to turn a successful weekly rebill into full access.

### 13.3 Card replacement

Card replacement uses a dedicated zero-amount hosted-form identity, the Solidgate equivalent of a SetupIntent:

1. atomically open one card-update attempt;
2. build an amount-zero form intent with `kind=card_update`;
3. after return, call `/status` for the exact order;
4. require exact user, email, currency, zero amount, successful reusable token, and non-conflicting provenance;
5. claim the still-current attempt;
6. write the account vault monotonically;
7. enqueue token-update jobs for billable active subscriptions;
8. do **not** restore access merely because a card was updated.

The subscription-token worker calls `/subscription/update-token`, uses generation fencing and leases, and rechecks that the subscription is still billable. A five-minute fulfillment cron retries jobs.

## 14. Webhook system of record

### 14.1 Endpoints and subscribed events

Production subscribes to:

- `card_gate.order.updated`;
- `alt_gate.order.updated`;
- `subscription.updated.v2`;
- `card_gate.chargeback.received`.

Every configured family requires a non-empty string entity identifier before
entity ordering or domain work begins:

- `card_gate.order.updated`, `alt_gate.order.updated`, and
  `card_gate.chargeback.received` require `order.order_id`;
- `subscription.updated.v2` requires `subscription.id`.

A missing, blank, padded, or non-string identifier is unresolved contract
drift, not evidence that the event belongs to another merchant. After the inbox
claim it therefore enters the fenced `failed` state and returns 5xx. The legacy
`subscription.updated` family also fails with an instruction to configure
`subscription.updated.v2`; any other top-level event type fails as unsupported.

For a locally owned `subscription.updated.v2`, `callback_type` must be one of:

- money/access lifecycle: `active`, `renew`, `recurring`, `restore`, `resume`,
  `redemption`, `retry`, `scheduled_for_retry`, `cancel`, or `expire`;
- scheduled/observational: `scheduled_for_cancellation`, `pause`,
  `pause_schedule.create`, `pause_schedule.update`, `pause_schedule.delete`,
  `switch_product`, `create`, `payment_attempt`, or `order_update`.

Ownership is resolved before applying this callback allowlist so a valid event
proven to describe another brand remains a completed no-op. Once ownership is
local, a missing or unknown callback fails before initial-order binding,
invoice/order persistence, identity merge, analytics, entitlement, or other
domain mutation.

Solidgate cannot send an application or Supabase user JWT. In this repository both Edge Function entries are configured with `verify_jwt=false` in `supabase/config.toml`, so the request can reach the handler and is authenticated by the raw-body Solidgate HMAC. Exempt only the exact webhook paths from application JWT/CSRF middleware; do not weaken authentication on adjacent routes.

The sandbox wrapper reuses the same handler with:

- sandbox webhook keys;
- `environment=sandbox`;
- a separate event ledger;
- customer-facing analytics/email/alert effects disabled;
- an optional preview-only fulfillment worker.

### 14.2 Event claim protocol

For every request:

1. read the raw body;
2. verify the signature with the configured webhook key before JSON parsing;
3. require event ID, event type, a valid provider creation time, and valid JSON;
4. return 4xx without creating or completing an inbox row when any of those
   pre-claim checks fail;
5. claim the event ID with a lease;
6. return success for an already-completed duplicate;
7. return retryable 503 with `Retry-After` if another worker owns an active claim;
8. validate the supported family and its required entity identifier;
9. fence processing by environment plus provider payment/subscription/chargeback entity;
10. compare the provider timestamp with the entity watermark;
11. ignore only events whose provider timestamp is strictly older; allow
    equal-timestamp events to reach domain-idempotent transitions;
12. use the existing local order, invoice-order, product, session, and account
    guards to decide ownership;
13. complete a valid, recognized event as a no-op when those guards prove it
    belongs to another brand;
14. for an owned subscription, validate `callback_type` before shared writes;
15. commit business state;
16. mark the event complete through
    `complete_solidgate_webhook_event_v2(environment, event_id, claim_token,
    claim_generation)`;
17. wake fulfillment and drain immediately available analytics work; the
    durable outbox rows, not this best-effort wake/drain, own subsequent retries.

Any post-claim classification, handler, entity-ordering, or database error
skips inbox completion. The handler releases a held entity lease and calls
`fail_solidgate_webhook_event_v2` with the same claim token and generation.
When that fence is still owned, the RPC stores the diagnostic `last_error`,
clears the claim token, and leaves the signed event type and payload in
`status=failed`; the response is 5xx. Provider redelivery then reclaims the
durable row. There is no in-process retry loop and no separate quarantine state.

The distinction is intentional:

- invalid signature, missing required envelope headers, invalid timestamp, or
  invalid JSON fails before the inbox claim with 4xx;
- unknown/legacy families, malformed required IDs, unknown callbacks on a
  locally owned subscription, and genuine processing failures fail after the
  claim with a durable fenced error and 5xx;
- recognized events with a valid ID that the database proves irrelevant
  complete as 2xx no-ops and do not create redelivery noise.

Never acknowledge failed business work as a completed duplicate.

For a portable implementation, also compare the received `Merchant` header
with the configured webhook public key. The current handler logs the merchant
header without an explicit equality rejection; that defense-in-depth gap is
separate from the implemented financial-family acknowledgement boundary.

### 14.3 Card order lifecycle

The handler first proves the order belongs to this integration through an existing local Solidgate order or renewal mapping. A recognizable product string alone is not sufficient.

For initial orders it validates:

- canonical merchant order grammar;
- exact local order ID;
- environment and owner/customer account;
- amount and currency;
- customer email;
- product, price, and subscription identities;
- exact metadata equality;
- captured amount.

Behavior:

- `settle_ok`: finalize the order and grant if exact;
- `partial_settled`: grant only when successful settle transactions sum to the expected amount;
- positive `auth_ok`: remain pending;
- zero `auth_ok`: grant only for the expected zero-amount subscription and only when a reusable token is durably present;
- decline/failure: mark terminal without downgrading a previously successful order;
- refund: store gross and cumulative refunded amounts, keep net amount separately, revoke only on full refund;
- void: fail/revoke;
- token: write only when the transaction and source order are aligned.

For provider-generated renewal order IDs, the handler uses `solidgate_invoice_orders` to map invoice and provider order identity back to the local subscription. It does not try to parse those IDs as merchant checkout IDs.

### 14.4 Subscription lifecycle

Use the invoice as financial evidence. A positive subscription callback alone is not enough to infer that a renewal was paid.

| Callback family | Local behavior |
|---|---|
| `create` | perform exact initial binding and applicable common bookkeeping, but wait for card financial evidence before an access transition |
| `active`, `renew`, `recurring`, `restore`, `resume` | activate/extend only with a successful bound invoice and valid lifecycle binding |
| `retry`, `redemption`, `scheduled_for_retry` | mark dunning/past-due according to product policy |
| `pause`, `pause_schedule.*`, `switch_product`, `order_update`, `payment_attempt` | perform applicable common invoice/order and identity bookkeeping, then observe without a dedicated access transition |
| `scheduled_for_cancellation` | retain access until the paid period ends |
| `cancel`, `expire` | revoke at the correct terminal boundary |

The current code achieves scheduled-cancellation retention by leaving access unchanged and emitting analytics; it does not persist a distinct scheduled state. `pause` has no dedicated access transition. `switch_product` still passes through common invoice/order persistence, and a successful later-term invoice can create renewal and analytics records, but it has no dedicated product/access transition. Implement those states before enabling the corresponding provider features.

The current business policy gives the main subscription up to 60 days of grace while Solidgate retries. Advisory access is cut immediately because it incurs ongoing per-use cost. These are application policies, not provider defaults; choose them per product.

A paid event for the same invoice wins over a late dunning event. Term zero binds to the exact initial order. Later terms create `renewal_events` and exact invoice-order mappings.

Provider `next_charge_at` is used only when it is sane. Defensive fallbacks match the actual product promise: seven days for an initial trial/advisory period and 30 days for the main recurring period.

### 14.5 Chargebacks

The handler maps a chargeback to either the initial order or an exact renewal order:

- receipt/reversal into dispute revokes access and records the disputed amount;
- an alert can be sent through a private Slack webhook;
- a chargeback reversal repairs financial ledger status and revenue;
- access is deliberately **not** restored automatically after a dispute reversal.

Manual review is safer than allowing an old payment event to reopen disputed access.

## 15. Durable fulfillment and analytics

The request/webhook path commits financial truth first. Non-financial effects use two durable outboxes, but their failure contracts differ:

- fulfillment uses unique effect keys, fenced leases, capped exponential backoff, completion state, and explicit manual review for conditions raised as `FulfillmentManualReviewError`; generic failures continue retrying rather than entering manual review after a fixed attempt count;
- analytics uses pending/processing/completed/failed states, but it has no owner-token fencing, scheduled backoff, exhaustion limit, or manual-review/dead-letter state; a failed delivery is immediately eligible to be claimed again;
- both recheck the relevant financial/reversal state before effects where that state can invalidate the work.

For another project, add an explicit exhaustion/dead-letter policy, alerts, and operator tooling to both outboxes.

Current effects include:

- entitlement/account enrichment;
- welcome and buyer automations;
- analytics events;
- cancellation of a replaced main subscription after lifetime purchase;
- active-subscription token updates after card replacement.

PDF/report purchases remain valid commercial effects, but this repository does not currently deliver their files through the fulfillment worker: new `deliver_oto_pdfs` jobs are deliberately not enqueued and legacy jobs are completed as no-ops. A target project must choose and implement its own durable report-generation/delivery contract.

Lifetime fulfillment must find and cancel every applicable main subscription for the session. A missing or ambiguous target is retryable/manual-review work, not silent success.

The funnel exposes `/api/internal/solidgate-fulfillment`; Vercel invokes it every five minutes and webhooks can wake it immediately. Authenticate cron and internal wake calls with separate strong secrets.

## 16. Database model

The core ledgers are:

| Table/family | Purpose |
|---|---|
| `orders` | immutable purchase snapshot plus current financial state |
| `entitlements` | access ledger, separate from payment status |
| `renewal_events` | recurring financial terms |
| `solidgate_webhook_events` | event-id claim, retry, and completion ledger |
| `solidgate_entity_watermarks` | per-entity ordering fence |
| `solidgate_invoice_orders` | provider renewal invoice/order mapping |
| `solidgate_session_vault` | pre-account token and source chronology |
| `solidgate_account_vault` | account token and source chronology |
| `solidgate_intro_claims` | merchant-wide introductory-offer exclusivity |
| `solidgate_main_checkout_states` | main hosted-form build/open state |
| `solidgate_pwa_purchase_states` | member-area form/submit/reconcile state |
| `solidgate_card_update_attempts` | one current zero-auth card replacement |
| `solidgate_subscription_token_sync_jobs` | durable token propagation |
| `solidgate_fulfillment_outbox` | customer/business side effects |
| `solidgate_analytics_outbox` | idempotent server analytics |
| user acquisition attribution | immutable UTM ownership |

Important RPC families include:

- `open_*`, `finalize_*`, and `record_*` for checkout claims;
- `grant_solidgate_*_entitlement` for atomic access;
- `claim/complete/fail_solidgate_webhook_event_v2`;
- entity-event claim/release functions;
- source-fenced session/account vault writers and promotion;
- OTO progress and intro-claim functions;
- card-update open/claim/finalize functions;
- subscription-token-sync enqueue/claim/complete/fail functions;
- fulfillment-outbox claim functions.

Sensitive tables use row-level security with no client policies and RPC execution restricted to the service role. Database triggers prevent an entitlement from being inserted or restored against a terminal/reversed Solidgate order.

This repository’s final schema is the result of a forward migration chain beginning with `00039_solidgate_columns.sql` and continuing through the timestamped Solidgate migrations. In this repository, apply that chain in order and follow the maintenance boundaries in `docs/solidgate/cutover-runbook.md`.

For a new project, do not blindly copy every historical corrective migration. Consolidate the **final reviewed schema and RPC definitions** into a clean baseline, retain their constraints and grants, and run the SQL concurrency tests against that baseline.

## 17. Stripe-to-Solidgate mapping

This table maps concepts and provider primitives. It does not claim every row has a complete customer/operator workflow in this repository; refund, general cancellation, and restore require product routes, authorization, reconciliation, UI, and UAT in the target project.

| Stripe concept | Solidgate/application replacement |
|---|---|
| PaymentIntent ID and idempotency key | merchant-generated `order_id` plus local atomic order state |
| `client_secret` | encrypted/signed Payment Form `merchantData` |
| Payment Element / Express Checkout | Solidgate hosted Payment Form |
| `confirmPayment` | iframe submission plus server `/status` confirmation |
| Stripe Customer | merchant-owned `customer_account_id` plus local account mapping |
| PaymentMethod | `recurring_token` plus signed `original_payment_method` |
| SetupIntent | zero-amount authorization |
| Price IDs in environment variables | provider products/prices seeded from code, committed ID map |
| one-time off-session PaymentIntent | amount-based `POST /recurring` |
| subscription created with saved PaymentMethod | product-based `POST /recurring` |
| invoice/subscription webhooks | extended subscription callback plus exact invoice/order mapping |
| Stripe webhook event ID | `solidgate-event-id` |
| Stripe event timestamp/order | `solidgate-event-created-at` plus an entity watermark; only strictly older events are stale, while equal timestamps proceed through domain-idempotent transitions |
| refund API | `/refund` with order ID and minor-unit amount |
| cancel at period end | `/subscription/cancel` with `force=false` |
| immediate cancellation | `/subscription/cancel` with `force=true` |
| restore | `/subscription/restore` |
| replace default payment method | zero auth, account vault update, `/subscription/update-token` jobs |
| test mode | separately keyed sandbox channel using the same API hosts |
| test clock | no direct equivalent in this implementation; use dedicated short-period sandbox products |
| subscription schedules | no equivalent used here; redesign the commercial flow |

## 18. Refactoring a live Stripe project

### Phase 0: inventory before changing code

Document every Stripe dependency:

- active subscriptions and schedules;
- trials, coupons, taxes, proration, discounts, invoices, and retry rules;
- PaymentIntents and SetupIntents;
- customer/payment-method ownership;
- Apple Pay/Google Pay and domain registrations;
- webhook events and their side effects;
- refunds, disputes, revenue reports, and admin queries;
- customer portal and cancellation UI;
- idempotency behavior;
- legal billing disclosures and statement descriptors;
- background jobs, analytics, emails, and fulfillment;
- every Stripe column and identifier exposed to application code.

Turn the inventory into a signed-off disposition matrix. Every Stripe feature must choose exactly one outcome:

| Disposition | Meaning |
|---|---|
| Solidgate equivalent | Implemented and UAT-tested against the target channel/version |
| Application-owned replacement | Rebuilt locally with explicit financial and lifecycle semantics |
| Stripe run-off | Existing obligations stay on Stripe and retain webhook/operator support |
| Removed | Product/legal/customer impact approved and communicated |

This repository did not implement Stripe taxes, coupons, proration, customer portal, or schedule parity because it had no live Stripe run-off and did not need those features. Do not infer parity from their absence. If any target-project feature has no approved disposition, cutover is blocked.

### Phase 1: choose a migration strategy

Use one of two explicit strategies:

**Hard cutover**

Use only when there are no live Stripe subscriptions, unsettled payments, refundable history requiring automation, or reusable Stripe payment methods that customers depend on. This repository used a hard cutover because Stripe had never launched.

**Parallel run-off**

Use for a live business:

- keep existing Stripe subscriptions on Stripe;
- keep Stripe webhook processing, refunds, disputes, and cancellation controls alive;
- send only new acquisitions or explicitly re-consented customers to Solidgate;
- store `psp` and provider-specific IDs on every order/subscription;
- route status, cancel, refund, admin, and analytics behavior by PSP;
- retire Stripe only when its financial and legal obligations have ended.

Do not copy Stripe payment method IDs or card tokens into Solidgate. A Solidgate reusable token must originate from a successful Solidgate-controlled credential capture.

### Phase 2: add the provider-neutral ledger

Before replacing checkout:

- add `psp` and `payment_environment`;
- separate financial orders from entitlements;
- add provider order/subscription/invoice/dispute fields;
- make admin and customer queries understand both PSPs;
- make fulfillment idempotent and PSP-neutral;
- preserve historical Stripe rows;
- ensure GDPR deletion, retention, exports, and processor disclosures cover both providers.

### Phase 3: build Solidgate foundations

Implement and test:

- environment/key guard;
- native-fetch client and signature helper;
- raw webhook verification;
- Payment Form encryption;
- canonical order grammar;
- product catalog and seeder;
- immutable checkout snapshot;
- atomic open/claim/follower RPCs;
- payment decision interpreter;
- session and account vaults with provenance;
- webhook event and entity ordering ledgers;
- fulfillment and analytics outboxes.

### Phase 4: migrate first checkout

- keep pricing in application code as the source of truth;
- seed provider products/prices in sandbox;
- open the local order before emitting merchant data;
- mount the hosted form;
- confirm the exact order on the server;
- grant only from provider evidence;
- test card, 3DS, decline, timeout, refresh, duplicate submit, paid trial, free trial, and every currency;
- add legal recurring consent and credential-on-file wording at the point of payment.

### Phase 5: migrate saved-method and member flows

- vault only signed provider tokens;
- store `original_payment_method`;
- obtain written wallet-token policy for the merchant/channel;
- make every charge recover the same order after ambiguity;
- implement full-page recurring 3DS;
- add a zero-auth card-update flow;
- update active subscriptions through a durable token-sync queue;
- never restore access merely because card update succeeded.

### Phase 6: deploy webhooks before relying on asynchronous state

- deploy production and sandbox endpoints with separate keys;
- make only the exact webhook paths publicly reachable without an application JWT, then require the provider HMAC inside the handler;
- register all four event types;
- verify raw signatures and duplicate handling;
- verify equal-timestamp ordering;
- test settlement after the buyer closes the page;
- test initial purchase, renewal, failed renewal, recovery, cancellation, partial/full refund, chargeback, and duplicate replay;
- confirm all outbox effects are idempotent.

### Phase 7: cut over safely

- verify the live catalog and committed IDs;
- require every Stripe feature in the disposition matrix to have implementation/UAT evidence or an active run-off owner;
- configure exact production origins and Apple Pay domains;
- verify descriptor behavior with a real low-value payment;
- pause checkout and webhook delivery for incompatible schema boundaries;
- apply migrations and deploy app plus final webhook contract together;
- probe unsigned webhooks for the expected rejection and release version;
- run sandbox UAT;
- resume queued webhooks before reopening checkout;
- open one low-volume locale first and widen gradually;
- monitor pending orders, event claims, entity locks, outboxes, token-sync jobs, refunds, disputes, and entitlement mismatches.

### Phase 8: retire Stripe only after run-off

Remove Stripe code only when:

- no active or scheduled Stripe subscription remains;
- refund/dispute windows and support obligations are handled;
- Stripe webhooks have no remaining business effects;
- exports and admin history remain readable;
- customer cancellation and data-deletion paths no longer require Stripe;
- secrets, packages, CI config, and obsolete scripts can be removed without hiding history.

Keep provider columns and immutable ledger rows when they are part of financial history. Deleting schema history is not the same as completing a migration.

## 19. Greenfield Solidgate build order

For a new application:

1. Define product promises, currencies, dunning policy, cancellation behavior, descriptor text, and entitlement rules.
2. Confirm Billing 1.0 versus 2.0 with Solidgate before designing the catalog or webhook schema.
3. Obtain sandbox API/webhook keys, wallet enablement, connector/descriptor details, and rate-limit information.
4. Implement signature, client, form encryption, and strict environment isolation.
5. Create the provider-neutral financial/entitlement schema and atomic order opener.
6. Define and seed a versioned multi-currency catalog.
7. Implement hosted checkout and exact-order server confirmation.
8. Implement signed token provenance and saved-method flows only if required.
9. Implement webhook idempotency, ordering, lifecycle mapping, and outboxes.
10. Implement refunds, cancellations, card update, disputes, admin reporting, and reconciliation.
11. Complete Apple Pay/domain/CSP configuration.
12. Run sandbox failure-path UAT, then a low-volume real-card production smoke test.

Even greenfield code should retain `psp` or an equivalent provider discriminator. It makes future migration, fallback, reconciliation, and historical reporting materially safer.

## 20. Security and compliance checklist

- [ ] API secrets and webhook secrets are server-only and stored in separate deployment scopes.
- [ ] Production cannot start with sandbox keys or an environment-marker mismatch.
- [ ] Raw webhook bytes are verified before JSON parsing.
- [ ] Signature comparison is constant-time.
- [ ] Local orders exist before provider submission.
- [ ] Amount/currency/product/email/owner/metadata are snapshotted and provider-bound.
- [ ] Return and 3DS URLs are generated server-side, HTTPS, allowlisted, and credential-free.
- [ ] Client SDK events cannot grant access.
- [ ] A paid checkout email cannot authenticate the browser as an existing user without inbox or existing-session proof.
- [ ] Service-role vault and webhook tables have no client RLS policies.
- [ ] Client input cannot select `payment_type`, token provenance, amount, or currency.
- [ ] Tokens are never logged and brand/last4 are treated as display data only.
- [ ] Unknown or legacy token provenance fails closed.
- [ ] Refund, void, chargeback, and revocation block grant replay.
- [ ] Duplicate and out-of-order events are tested.
- [ ] Side effects are idempotent and do not precede financial commits.
- [ ] Point-of-payment copy covers recurring amount/frequency, trial, cancellation, refund policy, legal entity, and credential-on-file/upsell mandate.
- [ ] Apple Pay domains, certificates, CSP, iframe permission, and MIME type are verified.
- [ ] The application never handles PAN or CVC.
- [ ] Data retention, deletion, privacy notices, and processor records name the actual provider and data flow.

## 21. Test plan

### 21.1 Automated suites in this repository

Run:

```bash
npm --workspace @repo/shared test
npm --workspace @repo/pwa test
npm --prefix apps/funnel run test:payments
```

With a disposable local Supabase database, also run the Solidgate SQL tests under `supabase/tests/`, including concurrency, payment identity, OTO step exclusivity/progress, card update, token origin, 3DS alias conflict, intro claims, and the zero-amount reusable-card guard.

The most important TypeScript suites cover:

- signature/form/client timeout and environment behavior;
- catalog and descriptor drift;
- source-fenced session/account vaults;
- payment-type provenance;
- saved-token outcome interpretation;
- main checkout and grant replay;
- OTO replay and attribution;
- member-area purchase/confirm/card update;
- webhook lifecycle and duplicates;
- fulfillment and subscription-token synchronization;
- browser callback and redirect recovery.

### 21.2 Required sandbox scenarios

- [ ] paid intro checkout, every tier;
- [ ] free zero-amount trial with a reusable token;
- [ ] every supported currency, including JPY;
- [ ] frictionless card;
- [ ] 3DS challenge and lost return message;
- [ ] decline followed by terminally proven N+1 retry;
- [ ] provider timeout after possible acceptance;
- [ ] concurrent double-click and parallel tabs;
- [ ] page close before grant, then webhook recovery;
- [ ] card-origin one-click purchase;
- [ ] Apple Pay first checkout and the approved subsequent-token behavior;
- [ ] product-based saved-token subscription in a non-default currency;
- [ ] recurring 3DS full-page return;
- [ ] exact and inexact partial settlement;
- [ ] duplicate webhook;
- [ ] newer event arriving before older event;
- [ ] equal provider timestamps reaching domain-idempotent transitions;
- [ ] renewal success;
- [ ] dunning, scheduled retry, and paid recovery;
- [ ] scheduled cancellation versus immediate cancellation;
- [ ] partial refund, cumulative full refund, and refund race;
- [ ] chargeback and chargeback reversal;
- [ ] zero-auth card update and token propagation;
- [ ] stale token-sync generation and subscription no longer billable;
- [ ] outbox retry, fencing, backoff, exhaustion, dead-letter, and operator-recovery policy.

### 21.3 Verification performed for this guide

On 2026-07-24, the documentation audit ran the following repository suites against the inspected working tree:

- shared package: 28 files, 313 tests passed;
- PWA: 13 files, 235 tests passed;
- funnel payment suite, including the Solidgate webhook tests: 39 files, 616 tests passed;
- combined: 80 test files and 1,164 tests passed.

The local Supabase SQL suite was not run because the Docker daemon was unavailable. No provider catalog mutation, live/sandbox charge, webhook registration, refund, cancellation, or deployment was performed during this documentation audit. Those remain environment-specific UAT and operational steps.

## 22. Operations and reconciliation

Monitor at least:

- age/count of pending and accepted orders;
- orders with provider IDs but no entitlement or with entitlement but reversed payment;
- webhook claims stuck beyond lease;
- failed/retrying webhook events by event type;
- stale entity watermarks or lock contention;
- invoice orders without a renewal mapping;
- fulfillment and analytics outbox age;
- token-sync job age/failure;
- full refunds/disputes with unrevoked access;
- successful payments without account linkage;
- catalog ID or price verification drift;
- wallet origin values that are unknown to the deployed code.

Operational rules:

- reconcile by exact provider order/subscription/invoice ID;
- do not delete ledger rows to force a retry;
- do not manually mark a locally pending order failed without provider evidence;
- do not reuse a legacy vault token by clearing a marker;
- do not restore access from a card update;
- after an incompatible schema boundary, fix forward with checkout and webhook delivery paused;
- retain only counts and non-sensitive state in shared logs; keep customer/provider identifiers in restricted incident records.

## 23. Items that must be re-confirmed for another merchant

These are channel-, contract-, or version-specific and must not be copied as universal facts:

1. Whether `cdn.charge-auth.com/js/form.js` is the intended SDK alias for the new channel. Public docs normally show the Solidgate CDN.
2. Billing 1.0 versus Billing 2.0 and the corresponding products, prices, subscription creation, and webhook contracts.
3. Whether Apple Pay/Google Pay-derived tokens may be used as `rebill` for the intended post-purchase flow, and the required customer mandate.
4. Whether the safer customer-present wallet re-presentation flow is required.
5. Descriptor base, connector type, supported suffix length, prefixes, truncation, and `/recurring`/renewal appearance.
6. Product catalog scope across sandbox/live channels for the merchant account.
7. Current API rate limits and webhook retry/timeout policy.
8. Apple Pay certificates, exact verified domains, iframe/top-level requirements, and supported browser behavior.
9. Google Pay merchant/domain requirements if it will be enabled.
10. Zero-amount authorization support and reusable-token behavior on every active connector.
11. Currency selection rules and whether separate subscriptions for one customer may use different currencies.
12. Whether metadata propagates to provider-generated rebills; the application should not rely on it.
13. Smart-retry and redemption configuration, especially for weekly products.
14. Regulatory and card-scheme requirements for trials, saved credentials, MITs, refunds, and cancellation in the target markets.

## 24. Official references

- [Access to API and request signing](https://docs.solidgate.com/payments/integrate/access-to-api/)
- [Create the hosted Payment Form](https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/)
- [Apple Pay button and domain verification](https://docs.solidgate.com/payments/integrate/payment-form/apple-pay-button/)
- [Recurring token payments](https://docs.solidgate.com/payments/card-payments/manage-card-payments/)
- [Token provenance and wallet restrictions](https://docs.solidgate.com/payments/card-payments/token-usage/)
- [Billing descriptors](https://docs.solidgate.com/payments/payments-insights/billing-descriptor/)
- [Webhook signatures, IDs, and ordering](https://docs.solidgate.com/payments/integrate/webhooks/)
- [Billing products](https://docs.solidgate.com/billing/manage-products/products/)
- [Multi-currency and trial prices](https://docs.solidgate.com/billing/manage-products/prices/)
- [Billing 1.0 extended subscription events](https://docs.solidgate.com/billing/subscriptions/subscriptions-1.0/subscription-insights/subscription-events/)

Use the checked-in OpenAPI snapshot to understand what this code was built against, but compare it with the current official API and the merchant’s enabled channel before changing request fields.
