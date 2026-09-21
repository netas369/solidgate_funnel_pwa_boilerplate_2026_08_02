// ─── Solidgate catalog seeder ───────────────────────────────────────────────
// Creates/reconciles the Solidgate products + per-currency prices defined in
// packages/shared/src/solidgate/catalog.ts in one config-driven run over the
// 8 catalog products. Per-locale pricing lives on the Solidgate price, not on
// separate per-locale products, which is why the catalog stays this small.
//
//   npx tsx scripts/solidgate-seed-catalog.ts             # dry run (default)
//   npx tsx scripts/solidgate-seed-catalog.ts --apply     # write to Solidgate
//   npx tsx scripts/solidgate-seed-catalog.ts --verify    # read back, diff vs catalog
//   npx tsx scripts/solidgate-seed-catalog.ts --apply --out <path>
//
// Re-running --apply is safe: products are matched on metadata.catalog_key and
// reused, and Solidgate upserts a price by (product, currency) rather than
// duplicating it (verified against the sandbox).
//
// Idempotent by metadata: an existing product whose metadata.catalog_key matches
// is reused, never duplicated. Which environment gets written is decided purely
// by which channel's keys are in the env (sandbox and live are separate
// channels — there is no test-mode flag).
//
// Amounts come from the catalog, which is itself generated from PRICE_MAP and
// pinned by tests — the seeder never carries its own copy of a number.

import dotenv from 'dotenv';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { SolidgateClient, type SolidgateKeys } from '../packages/shared/src/solidgate/client';
import {
  CATALOG_CURRENCIES,
  SOLIDGATE_PRODUCTS,
  type SolidgateProductDef,
} from '../packages/shared/src/solidgate/catalog';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/funnel/.env.local') });

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const OUT_FLAG = process.argv.indexOf('--out');
const OUT_PATH =
  OUT_FLAG >= 0 ? process.argv[OUT_FLAG + 1] : 'packages/shared/src/solidgate/catalog-ids.json';

// EUR is the fallback Solidgate charges when a customer's currency has no price.
const DEFAULT_CURRENCY = 'eur';

interface SolidgateProduct {
  id: string;
  name: string;
  status?: string;
  billing_period?: { unit: string; value: number };
  metadata?: Record<string, string>;
}

interface SolidgatePrice {
  id: string;
  currency: string;
  product_price: number;
  trial_price?: number;
  default: boolean;
  status: string;
}

function keys(): SolidgateKeys {
  const publicKey = process.env.SOLIDGATE_API_PUBLIC_KEY;
  const secretKey = process.env.SOLIDGATE_API_SECRET_KEY;
  if (!publicKey || !secretKey) {
    console.error('Missing SOLIDGATE_API_PUBLIC_KEY / SOLIDGATE_API_SECRET_KEY (apps/funnel/.env.local)');
    process.exit(1);
  }
  return { publicKey, secretKey };
}

/** Products and prices live on the subscriptions host — pay.solidgate.com WAF-blocks them. */
async function listProducts(client: SolidgateClient): Promise<SolidgateProduct[]> {
  // The API paginates on pagination[limit]/pagination[offset]; a bare `limit`
  // is ignored and the default page is 10 — which once made the seeder blind
  // to its own products and duplicate them.
  const all: SolidgateProduct[] = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const res = await client.get<{ products?: SolidgateProduct[]; data?: SolidgateProduct[] }>(
      'subscriptions',
      'products',
      { 'pagination[limit]': PAGE, 'pagination[offset]': offset },
    );
    const page = res.products ?? res.data ?? [];
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

function productPayload(def: SolidgateProductDef) {
  return {
    name: def.displayName,
    type: 'recurring',
    description: `${def.displayName} — ${def.productCode}`,
    // Shown on bank statements and email receipts, so keep it customer-legible.
    public_description: def.displayName,
    status: 'active',
    payment_action: 'auth_settle',
    // Hours to delay auto-settlement; 0 = capture immediately. REQUIRED by the
    // API for every auth_settle action (product and trial alike) even though
    // the OpenAPI spec omits it from `required` — a missing value 400s with
    // constraint settle_interval: NotBlank.
    settle_interval: 0,
    billing_period: { unit: def.billingPeriod.unit, value: def.billingPeriod.value },
    ...(def.trial && {
      trial: {
        billing_period: { unit: def.trial.period.unit, value: def.trial.period.value },
        payment_action: def.trial.paymentAction,
        // Only the paid (auth_settle) trial settles; a zero-amount auth has
        // nothing to capture, and the API rejects the field there.
        ...(def.trial.paymentAction === 'auth_settle' && { settle_interval: 0 }),
      },
    }),
    // Smart retries: ML-timed dunning, Solidgate's default (4 tries / 4 weeks).
    retry_mode: 'smart',
    metadata: {
      catalog_key: def.key,
      product_code: def.productCode,
      tier: def.key,
    },
  };
}

function pricePayload(def: SolidgateProductDef, currency: string) {
  const cur = currency as keyof typeof def.rebillAmounts;
  return {
    default: currency === DEFAULT_CURRENCY,
    status: 'active',
    currency: currency.toUpperCase(),
    product_price: def.rebillAmounts[cur],
    // Only paid trials carry an intro amount; the API rejects trial_price: 0,
    // which is why a free trial must be a zero-amount auth instead (as
    // special_free/addon_trial were before the 2026-07-29 €1 switch).
    ...(def.trial?.amounts && { trial_price: def.trial.amounts[cur] }),
  };
}

/** Reads the channel back and diffs every product/price against the catalog. */
async function verify(client: SolidgateClient): Promise<never> {
  const ids: Record<string, { product_id: string; prices: Record<string, string> }> = JSON.parse(
    readFileSync(OUT_PATH, 'utf8'),
  );
  let failures = 0;

  for (const def of SOLIDGATE_PRODUCTS) {
    const entry = ids[def.key];
    if (!entry) {
      console.log(`✗ ${def.key}: absent from ${OUT_PATH}`);
      failures++;
      continue;
    }
    const res = await client.get<{ data?: SolidgatePrice[] }>(
      'subscriptions',
      `products/${entry.product_id}/prices`,
      { limit: 100 },
    );
    const prices = res.data ?? [];
    const byCurrency = new Map(prices.map((p) => [p.currency.toLowerCase(), p]));
    const problems: string[] = [];

    if (prices.length !== CATALOG_CURRENCIES.length) {
      problems.push(`${prices.length} prices, expected ${CATALOG_CURRENCIES.length}`);
    }
    if (prices.filter((p) => p.default).length !== 1) {
      problems.push('expected exactly one default price');
    }
    for (const currency of CATALOG_CURRENCIES) {
      const price = byCurrency.get(currency);
      if (!price) {
        problems.push(`${currency} missing`);
        continue;
      }
      const wantRebill = def.rebillAmounts[currency];
      const wantTrial = def.trial?.amounts?.[currency];
      if (price.product_price !== wantRebill) {
        problems.push(`${currency} rebill ${price.product_price} ≠ ${wantRebill}`);
      }
      if (wantTrial === undefined) {
        if (price.trial_price) problems.push(`${currency} has trial_price ${price.trial_price}`);
      } else if (price.trial_price !== wantTrial) {
        problems.push(`${currency} trial ${price.trial_price} ≠ ${wantTrial}`);
      }
      if (entry.prices[currency] !== price.id) {
        problems.push(`${currency} id drifted from ${OUT_PATH}`);
      }
    }

    if (problems.length) {
      failures++;
      console.log(`✗ ${def.key}: ${problems.join('; ')}`);
    } else {
      console.log(`✓ ${def.key.padEnd(16)} ${prices.length} prices match the catalog`);
    }
  }

  console.log(failures ? `\n${failures} product(s) FAILED` : `\nAll ${SOLIDGATE_PRODUCTS.length} products match the catalog.`);
  process.exit(failures ? 1 : 0);
}

async function main() {
  const client = new SolidgateClient(keys());
  if (VERIFY) await verify(client);
  console.log(`Solidgate catalog seeder — ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}`);
  console.log(`Channel: ${process.env.SOLIDGATE_API_PUBLIC_KEY?.slice(0, 18)}…\n`);

  const existing = await listProducts(client);
  // Archived products cannot join new subscriptions — never match them.
  const byKey = new Map(
    existing
      .filter((p) => p.metadata?.catalog_key && p.status !== 'archived')
      .map((p) => [p.metadata!.catalog_key, p]),
  );
  console.log(`${existing.length} product(s) already in the channel, ${byKey.size} live with a catalog_key\n`);

  const ids: Record<string, { product_id: string; prices: Record<string, string> }> = {};

  for (const def of SOLIDGATE_PRODUCTS) {
    const found = byKey.get(def.key);
    const trialLabel = def.trial
      ? `${def.trial.paymentAction === 'auth_settle' ? 'paid' : 'free'} ${def.trial.period.value}${def.trial.period.unit[0]} trial`
      : 'no trial';
    console.log(
      `▸ ${def.key.padEnd(16)} ${def.productCode.padEnd(30)} ${def.billingPeriod.value}${def.billingPeriod.unit[0]} · ${trialLabel}`,
    );

    if (!APPLY) {
      const sample = pricePayload(def, DEFAULT_CURRENCY);
      console.log(
        `    ${found ? `exists (${found.id}) → reconcile` : 'CREATE'} + ${CATALOG_CURRENCIES.length} prices` +
          ` (eur: ${sample.product_price}${sample.trial_price !== undefined ? ` after ${sample.trial_price} intro` : ''})`,
      );
      continue;
    }

    let productId: string;
    let reused = false;
    if (found) {
      // A product's billing period is fixed once it has subscriptions/prices;
      // when the catalog changed it, retire the old product and start fresh.
      const period = found.billing_period;
      const periodMatches =
        period && period.unit === def.billingPeriod.unit && period.value === def.billingPeriod.value;
      if (periodMatches) {
        productId = found.id;
        reused = true;
        console.log(`    reusing ${productId}`);
      } else {
        await client.request('subscriptions', `products/${found.id}/archive`, {});
        console.log(
          `    archived ${found.id} (billing period ${period?.value}${period?.unit?.[0] ?? '?'} → ${def.billingPeriod.value}${def.billingPeriod.unit[0]})`,
        );
        const created = await client.request<{ id: string }>(
          'subscriptions',
          'products',
          productPayload(def),
        );
        if (!created.id) throw new Error(`create failed for ${def.key}: ${JSON.stringify(created)}`);
        productId = created.id;
        console.log(`    created ${productId}`);
      }
    } else {
      const created = await client.request<{ id: string }>(
        'subscriptions',
        'products',
        productPayload(def),
      );
      if (!created.id) throw new Error(`create failed for ${def.key}: ${JSON.stringify(created)}`);
      productId = created.id;
      console.log(`    created ${productId}`);
    }

    // A reused product already carries prices: reconcile instead of re-POSTing
    // (a second default price 422s). Amount drift is a hard error — prices are
    // immutable inputs to live billing, never silently rewritten.
    const existingPrices = new Map<string, SolidgatePrice>();
    if (reused) {
      const res = await client.get<{ data?: SolidgatePrice[] }>(
        'subscriptions',
        `products/${productId}/prices`,
        { limit: 100 },
      );
      for (const p of res.data ?? []) existingPrices.set(p.currency.toLowerCase(), p);
    }

    const prices: Record<string, string> = {};
    for (const currency of CATALOG_CURRENCIES) {
      const have = existingPrices.get(currency);
      if (have) {
        const want = pricePayload(def, currency);
        // Solidgate reports trial_price 0 where we send none (free trials).
        if (
          have.product_price !== want.product_price ||
          (have.trial_price || undefined) !== want.trial_price
        ) {
          throw new Error(
            `${def.key}/${currency}: existing price ${have.product_price}/${have.trial_price} ≠ catalog ${want.product_price}/${want.trial_price} — archive the product and re-run`,
          );
        }
        prices[currency] = have.id;
        continue;
      }
      const res = await client.request<{ id: string }>(
        'subscriptions',
        `products/${productId}/prices`,
        pricePayload(def, currency),
      );
      if (!res.id) throw new Error(`price failed ${def.key}/${currency}: ${JSON.stringify(res)}`);
      prices[currency] = res.id;
    }
    console.log(`    ${Object.keys(prices).length} prices${reused ? ` (${existingPrices.size} pre-existing)` : ''}`);
    ids[def.key] = { product_id: productId, prices };
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to create in the channel.`);
    return;
  }

  writeFileSync(OUT_PATH, JSON.stringify(ids, null, 2) + '\n');
  console.log(`\nWrote ${OUT_PATH} (${Object.keys(ids).length} products).`);
  console.log('Product/price ids are not secrets — commit this file; it is the only place the provider ids live.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
