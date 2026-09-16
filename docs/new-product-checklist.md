# New Product Checklist

Everything you must change to turn this boilerplate into a real product. Work top to
bottom — later steps assume earlier ones are done.

The guiding principle of this repo: **reuse the platform layer, replace the product layer.**
Payments, auth, entitlements, webhooks, analytics, the quiz engine, the admin dashboard and
the PWA shell are the platform. Copy, prices, products, branding and assets are the product.

---

## 0. Repo identity

| What | Where |
|---|---|
| Package name | `package.json` → `"name"` |
| Supabase project ref | `supabase/config.toml` → `project_id` |
| App names / ports | `apps/funnel/package.json`, `apps/pwa/package.json` (3205 / 3206) |

---

## 1. Brand

`packages/shared/src/boilerplate-brand.ts` is the single brand seam. It feeds both root
layouts (title/description/OG/Twitter), both `manifest.ts` files, `robots.ts`, `sitemap.ts`,
the shared login page, the welcome email, the OTP email and the digital-delivery email.

Change the values there first, then:

- Replace the placeholder icons in `apps/funnel/public/images/favicon/` and
  `apps/pwa/public/images/favicon/`. **The filenames are load-bearing** — `manifest.ts`
  and the layouts reference them by exact path.
- Replace `apps/funnel/public/og-image.png` and `apps/pwa/public/og-image.png`.

---

## 2. Solidgate products

This is the step people get wrong. Read it fully.

### How the catalog works

Sandbox and live are **separate channels with separate key pairs on the same hosts**.
There is no test-mode flag — *which environment you write to is decided purely by which
channel's keys are in your env.*

Only **subscriptions** need catalog products (Solidgate reads billing period, trial and
price from the product). One-time OTOs carry no product at all: they are charged through
`POST /recurring` with an explicit amount + currency.

Amounts are **generated from `PRICE_MAP`**, which is the single source of truth. The seeder
never carries its own numbers, and a test pins the two together so they cannot drift.

### Steps

1. **Define prices** in `packages/shared/src/price-map.ts`.
   Set `PRODUCT_CODE_PREFIX` and `PRICE_BATCH` to your own values, then the amounts per
   product × locale. Company codes (`EN_BRAND_000000_SUB`) are generated, not hand-typed.

2. **Define products** in `packages/shared/src/solidgate/catalog.ts`. Each
   `SolidgateProductDef` needs:
   - `key` — stable catalog key, used for idempotent matching (`metadata.catalog_key`)
   - `productCode` — the offering code written to `orders.product_slug`
   - `displayName` — customer-facing product wording; keep it legible. It does not set the bank statement descriptor
   - `billingPeriod: { unit, value }`
   - optional `trial: { period, paymentAction, amounts }`
   - `rebillAmounts` keyed by every currency in `CATALOG_CURRENCIES`

3. **Put your channel's keys** in `apps/funnel/.env.local` — the seeder dotenv-loads
   exactly that path:
   ```
   SOLIDGATE_API_PUBLIC_KEY=api_pk_...
   SOLIDGATE_API_SECRET_KEY=api_sk_...
   ```

4. **Dry run** (default — writes nothing):
   ```bash
   npx tsx scripts/solidgate-seed-catalog.ts
   ```
   Prints a per-product CREATE/reconcile plan plus the EUR sample price.

5. **Apply**:
   ```bash
   npx tsx scripts/solidgate-seed-catalog.ts --apply
   ```
   Creates products + one price per currency and writes
   `packages/shared/src/solidgate/catalog-ids.json`.
   **Commit that file.** The ids are not secrets and this file is the only place
   they live; there is no env-var fallback. The version in this boilerplate is scrubbed to empty
   strings on purpose, so an unseeded install fails loudly at the Solidgate API instead
   of silently posting a plausible-looking id.

6. **Verify** (reads the channel back, diffs against the catalog, exits 1 on drift):
   ```bash
   npx tsx scripts/solidgate-seed-catalog.ts --verify
   ```

Re-running `--apply` is idempotent: products are matched on `metadata.catalog_key`,
archived products are never matched, and prices are upserted by `(product, currency)`.

### Gotchas that will cost you a day

- If a price amount drifts from the catalog the seeder **throws** rather than silently
  rewriting a live billing input. Recover with
  `npx tsx scripts/solidgate-archive-catalog-product.ts <key>` then re-run `--apply`.
- If the **billing period** changed, the seeder auto-archives and recreates the product.
- `trial_price: 0` is **rejected by the API**. Model a free trial as a zero-amount auth
  (`payment_action: auth_0_amount`), not a zero trial price.
- `settle_interval: 0` is **required** on every `auth_settle` action, even though the
  OpenAPI spec does not list it as required.
- Every product uses the **static descriptor configured on the Solidgate channel/connector**.
  Omit `dynamic_descriptor` from all requests, including Payment Form and `/recurring`.
  Do not create per-product suffixes or pass the full static value as a suffix.
  Product codes and locale-based `order_description` still identify each purchase.
  Verify the same static configuration on every connector route and existing subscription renewals;
  changing application code does not change provider settings or old transactions.

---

## 3. Payments plumbing

| What | Where |
|---|---|
| Entitlement slugs that grant app access | `packages/shared/src/entitlements.ts` → `APP_ACCESS_PRODUCT_SLUGS` |
| Add-ons excluded from the grace window | `packages/shared/src/grace-period.ts` → `GRACE_EXCLUDED_*` |
| Product label vocabulary | `packages/shared/src/oto-product-label.ts` |
| Static statement descriptor for all products | Solidgate channel/connector settings; `packages/shared/src/solidgate/form.ts` |
| Webhook handling | `supabase/functions/solidgate-webhooks/` |

**CSP note:** `next.config.ts` sets `frame-src` for the Solidgate 3DS iframe. Add **both**
your apex and `www` origins — they are different origins, and a mismatch blocks the 3DS
return with a generic `payment_error`.

**Apple Pay:** drop your domain-verification file into `apps/funnel/public/.well-known/`
and `apps/pwa/public/.well-known/`. The previous product's files were removed because they
are cryptographically bound to its domains.

---

## 4. Quiz

The engine (store, navigation, `funnel_events`, session persistence, render dispatch) is
product-agnostic. Only content changes.

- `apps/funnel/src/features/quiz/config/quiz-config.ts` — the step list, branching
  (`nextStepId`), `storeAs` keys, `totalSteps` and `stepPositions`
- `apps/funnel/src/features/quiz/config/quiz-schema.ts` — the step-type union; add a type
  here plus a `renderStep` case only if you need a genuinely new interaction
- `packages/i18n/messages/en/quiz.json` — all copy

Available generic step types ship as a library — single/multi select, picture and text
select, chips, likert, slider, date and time wheels, input groups, email capture with
consent, loader/interstitial screens, expert note, social wall, price step.

---

## 5. Offer, OTOs, success

- `apps/funnel/src/features/offer/config/offer-data.ts` — offer structure
- `apps/funnel/src/features/oto/config/oto-config.ts` — **all 8 OTO slots are driven from
  this one config through a shared template.** Change copy, price ids and accept/decline
  targets here rather than writing new page components.
- `apps/funnel/src/features/results/config/results-config.ts`
- `packages/i18n/messages/en/{offer,oto,success}.json`

OTO 3 keeps a "choose one of N bundles" pattern; OTO 8 is the summary/recap page.

---

## 6. PWA member area

- `apps/pwa/src/app/[locale]/(app)/dashboard/` — the shell, bottom nav and tabs
- `packages/i18n/messages/en/pwa.json`, `billing.json`
- Design tokens live in the dashboard's CSS. Restyle there rather than per component.

---

## 7. Legal

- `apps/funnel/src/features/legal/config/legal-content.ts` — company name, address,
  refund window, subscription terms
- `packages/i18n/messages/en/legal.json`
- Routes: `apps/funnel/src/app/[locale]/(legal)/{terms,privacy,cookies,subscription,money-back,contact}`

**These ship as placeholders and are not legal advice.** Have them reviewed before you take
real payments.

---

## 8. Locales

The boilerplate ships `en` only, but **all the multi-locale infrastructure is intact**.
To add a locale:

1. Add the folder `packages/i18n/messages/<locale>/` with the 9 namespace files
2. Add the locale to `packages/i18n/src/routing.ts`
3. Add it to `LOCALE_CURRENCY_MAP` and `PRICE_MAP` in `packages/shared/src/price-map.ts`
4. Add its company prefix to `packages/shared/src/locale-prefixes.ts`
5. Add it to `ENABLED_CHECKOUT_LOCALES`

Until a locale has a message folder, `getMessages()` falls back to `en` with a warning
rather than throwing, so routing stays exercisable.

**Gendered copy convention** (carried over, worth keeping): use `<g>MASCULINE|FEMININE</g>`
for spans that inflect for the user's gender — first form masculine, second feminine,
exactly one pipe. Preserve `{{fullName}}`, `<hw>…</hw>`, `<hl>…</hl>` and next-intl
single-brace `{tokens}` verbatim. Do not gender third-party testimonial quotes.

---

## 9. Analytics

Wiring is product-agnostic and already in place; you only supply IDs
(`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`,
`NEXT_PUBLIC_GTM_ID`).

Review event names and the purchase-value mapping in
`apps/funnel/src/features/analytics/` so your funnel steps report meaningfully.

> ⚠️ **Consent:** this boilerplate loads trackers unconditionally. That was the previous
> owner's decision, not a safe default. If you serve the EU/UK, decide your consent-banner
> approach deliberately before launch — see `docs/gdpr-compliance.md`.

---

## 10. Database

`supabase/migrations/00001_baseline.sql` is a clean platform-only baseline: sessions,
orders, entitlements, funnel events, OTP, user prefs and the Solidgate state machine.
Add your product tables as new migrations on top; don't edit the baseline in place once
you have deployed it.

Regenerate types after any schema change:
```bash
npx supabase gen types typescript --linked > packages/shared/src/types/database.ts
```

---

## 11. Before launch

- [ ] `ADMIN_EMAILS` set — the admin dashboard is unreachable until it is
- [ ] `RESEND_FROM_ADDRESS` set to a sender verified in Resend
- [ ] `PAYMENT_COOKIE_SECRET` and `INTERNAL_API_SECRET` are fresh random values
- [ ] `SOLIDGATE_ENVIRONMENT=production` **only** in the Vercel Production scope
- [ ] Solidgate catalog seeded against the **live** channel and `--verify` clean
- [ ] Apple Pay domain association files in place for your domains
- [ ] `frame-src` CSP covers apex **and** www
- [ ] Legal pages reviewed by someone qualified
- [ ] Consent approach decided
- [ ] A real end-to-end purchase completed in sandbox, including a 3DS card
