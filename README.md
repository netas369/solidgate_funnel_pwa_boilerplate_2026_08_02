# Funnel + PWA Boilerplate

A reusable monorepo starter for **quiz funnels, OTO/upsell flows, and a gated PWA member
area**, backed by Supabase and Solidgate.

Its guiding principle: **reuse the platform layer, replace the product layer.**

| Platform (reuse as-is) | Product (replace per launch) |
|---|---|
| Solidgate payments, 3DS, webhooks, refunds, chargebacks | Prices and product catalog |
| OTP auth, entitlements, grace periods, card updates | Quiz questions, offer and OTO copy |
| Quiz engine + generic step-type library | Branding, assets, legal entity |
| PostHog, Meta Pixel + CAPI, GTM | Member-area content |
| Admin analytics dashboard | |
| i18n routing, multi-currency pricing | |
| PWA shell, offline, install | |

The content that ships is deliberately **neutral placeholder** — it exists so the funnel
runs end to end on a fresh clone, not because it is worth keeping.

---

## Layout

```
apps/
  funnel/     quiz -> offer -> checkout -> 8 OTO slots -> success        (:3205)
  pwa/        gated member area, Serwist PWA shell                       (:3206)
packages/
  shared/     Solidgate client + catalog, price map, entitlements, auth, emails, DB types
  i18n/       next-intl routing + message packs (ships `en`; infra supports 15 locales)
supabase/
  migrations/00001_baseline.sql   the entire schema, one idempotent file
  functions/solidgate-webhooks/   payment webhook (Deno edge function)
  tests/                          psql behaviour tests for the PL/pgSQL money logic
scripts/     Solidgate catalog seeding, price exports, reconciliation tooling
docs/        new-product checklist, runbooks, Solidgate implementation guide
```

The complete two-table quiz persistence contract, current implementation gaps, API examples,
and AI-agent rules are in **[docs/quiz-backend/README.md](docs/quiz-backend/README.md)**.

## Stack

Next.js App Router · React · TypeScript · Tailwind · Zustand · next-intl ·
Supabase (Postgres + Auth + Edge Functions) · Solidgate (hosted payment form via
`@solidgate/react-sdk`) · Serwist · Vitest · Turborepo

---

## Getting started

```bash
npm install

cp apps/funnel/.env.example apps/funnel/.env.local    # then fill in
cp apps/pwa/.env.example    apps/pwa/.env.local

npx supabase start                                    # local stack
npx supabase db reset                                 # applies 00001_baseline.sql

npm run dev            # both apps
npm run dev:funnel     # funnel only  -> http://localhost:3205
npm run dev:pwa        # PWA only     -> http://localhost:3206
```

`.env.example` at the repo root is the master reference: every variable, which app reads
it, and whether it is required.

### Checkout will not work until you seed a catalog

`packages/shared/src/solidgate/catalog-ids.json` ships **empty on purpose** — the previous
product's live Solidgate IDs were scrubbed from it. Create the products in your own
Solidgate merchant account, then seed:

```bash
npx tsx scripts/solidgate-seed-catalog.ts            # dry run
npx tsx scripts/solidgate-seed-catalog.ts --apply    # writes catalog-ids.json — commit it
npx tsx scripts/solidgate-seed-catalog.ts --verify   # read back and diff
```

A test fails if real IDs are ever committed back into the boilerplate.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Both apps via turbo |
| `npm run build` | Production build of both apps |
| `npm run test` | All workspace test suites |
| `npm run lint` | ESLint across workspaces |
| `npm run test:coverage:payments` | Payment-path coverage run |

Database behaviour tests live in `supabase/tests/` and are plain `psql` assertion scripts
(not pgTAP). They are the only coverage of the PL/pgSQL money logic — see
`supabase/tests/README.md`.

---

## Starting a new product

The Solidgate architecture audit, all table/column explanations, pricing analysis and
continuation notes are collected in **[docs/solidgate/README.md](docs/solidgate/README.md)**.
For continuous reading, open **[the complete analysis](output/solidgate-reader/solidgate-analysis.html)**.
The imported findings describe the source project and must be checked against this
boilerplate before implementation.

Read **[docs/new-product-checklist.md](docs/new-product-checklist.md)** — it walks the whole
path in order, from `boilerplate-brand.ts` through Solidgate catalog seeding to the
pre-launch checks.

Fastest orientation: two files drive almost everything.

1. `packages/shared/src/boilerplate-brand.ts` — name, URLs, support email, OG copy
2. `packages/shared/src/price-map.ts` — products, prices, currencies, product codes

### Four places encode the product catalog and must change together

Drift here does not corrupt data — checkout fails loudly with `SQLSTATE 23514` — but it
does take checkout down:

1. `packages/shared/src/price-map.ts`
2. `packages/shared/src/oto-product-label.ts`
3. `supabase/migrations/00001_baseline.sql` § 2 (PRODUCT CATALOG)
4. `supabase/functions/solidgate-webhooks/_codes.ts`

`sql-price-grid-parity.test.ts` pins 1 against 3.

---

## Things that will bite you

- **PostgREST filter strings are invisible to TypeScript.** Dropping or renaming a column
  produces no compile error inside `.or()` / `.eq()` / `.select('…')` strings — it 400s at
  runtime. Grep by hand after any schema change.
- **Solidgate sandbox and live are separate channels**, not a test-mode flag. Which one you
  hit depends purely on which key pair is in the environment.
- **The 3DS `frame-src` CSP must list both apex and `www`** — they are different origins,
  and a mismatch fails the 3DS return with a generic `payment_error`.
- **Regenerate `database.ts` after every migration.** If it disagrees with the database,
  the database wins and the compiler stays silent.
- **The shipped prices are fake**, converted from EUR at flat invented rates. Replace the
  whole grid before launch.
- **The shipped legal pages are placeholders**, not legal advice.
- **Trackers load unconditionally.** If you serve the EU/UK, decide your consent approach
  deliberately — see [docs/gdpr-compliance.md](docs/gdpr-compliance.md).
