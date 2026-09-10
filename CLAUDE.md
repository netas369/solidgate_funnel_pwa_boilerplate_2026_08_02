# Repo context for AI coding tools

Keep this file **generic**. It is the boilerplate's context, not a product's. Add
product-specific strategy only after the new product is actually defined — and delete it
again before the repo is reused.

## What this is

A funnel + PWA boilerplate: quiz funnel with OTO/upsell flow, and a gated member area,
on Supabase + Solidgate. See `README.md` for layout and `docs/new-product-checklist.md`
for the customization path.

**Reuse the platform layer, replace the product layer.** Payments, auth, entitlements,
webhooks, analytics, the quiz engine, the admin dashboard and the PWA shell are platform.
Copy, prices, products, branding and assets are product.

## Current state

- Product content is **neutral placeholder** on purpose. Brand is `Acme`, product codes
  are `BRAND*_000000_*`, prices are fake, legal pages are stubs.
- `packages/shared/src/solidgate/catalog-ids.json` is **empty** — checkout cannot reach a
  rendered Solidgate form until someone seeds their own catalog.
- Only the `en` message pack ships. All 15 routing locales still route and fall back to
  `en` with a warning.

## Solidgate module review

The ongoing payment-module review starts at `docs/solidgate/README.md` and
`docs/solidgate/HANDOFF.lt.md`. The imported audit describes a source implementation;
verify each finding against this boilerplate before changing code. API v1 / Billing 1.0
is the selected direction. Proposed schema changes are not applied migrations, and
the source project's product examples must not become this boilerplate's configuration.

## Stack

Next.js App Router · React · TypeScript · Tailwind · Zustand · next-intl · Supabase ·
Solidgate (`@solidgate/react-sdk`) · Serwist · Vitest · Turborepo

## Conventions

- `apps/funnel` is `:3205`, `apps/pwa` is `:3206`.
- Feature code lives under `src/features/<feature>/{components,config,lib,hooks}`.
- Content lives in `config/*.ts` + `packages/i18n/messages/en/*.json`, not inline in
  components. When adding content, extend the config — don't hardcode it in JSX.
- The quiz is config-driven (`features/quiz/config/quiz-config.ts` against
  `quiz-schema.ts`). Add a new step *type* only when the interaction is genuinely new.
- Quiz persistence uses one mutable `sessions` row containing the complete
  `quiz_answers` JSONB object plus append-only `funnel_events`. Do not add one row per
  answer. Read `docs/quiz-backend/README.md` before changing this contract.
- All 8 OTO slots render one config-driven template from `features/oto/config/oto-config.ts`.
  Add an offer by editing config, not by writing a new page component.

## Rules that are load-bearing

1. **Never commit real Solidgate product/price IDs.** `catalog-ids.json` ships empty and a
   test enforces it. Seed locally, keep it out of the boilerplate.
2. **PostgREST filter strings are invisible to TypeScript.** A dropped column inside
   `.or('col.is.null')` / `.eq('col', x)` / `.select('a,b')` compiles fine and 400s at
   runtime. Grep by hand after any schema change.
3. **The product catalog is encoded in four places** and they must change in one commit:
   `price-map.ts`, `oto-product-label.ts`, `00001_baseline.sql` § 2, and the webhook's
   `_codes.ts`. `sql-price-grid-parity.test.ts` pins the first against the third.
4. **`solidgate_main_checkout_amount()` is the server-side price authority.** The browser's
   amount is checked against it; drift fails checkout with `SQLSTATE 23514`.
5. **Regenerate `packages/shared/src/types/database.ts` after every migration.**
6. **Don't put app-specific CSS utilities in `packages/shared`.** Components there render
   in *both* apps; an app-defined class renders unstyled in the other one. That was a real
   shipped bug.
7. **Preserve the operational comments.** Comments explaining 3DS quirks, wallet handling,
   race conditions and fail-closed reads encode incidents. Rewrite product nouns in them,
   never delete the reasoning.

## Testing

- `npm run test` runs every workspace.
- `supabase/tests/*.sql` are plain `psql` assertion scripts and hold the only coverage of
  the PL/pgSQL money logic. Run them against a scratch cluster — see
  `supabase/tests/README.md`.
- The Solidgate webhook suite runs under `apps/funnel`'s vitest config (it aliases Deno
  `npm:` specifiers).

## Don't

- Don't add fake testimonials, press logos, review counts or accuracy statistics to
  placeholder content. Someone will ship it.
- Don't reintroduce a second batch/version constant — there is exactly one (`PRICE_BATCH`).
- Don't hand-write per-locale product codes; they are generated.
