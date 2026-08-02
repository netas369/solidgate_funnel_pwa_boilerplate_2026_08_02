// ─── One-off: archive Solidgate catalog products by catalog key ─────────────
// The seeder refuses to change prices/trial config on a live product; the
// switch from free auth_0_amount trials to €1 auth_settle trials therefore
// needs the OLD special_free / addon_trial products archived first, then a
// fresh `--apply` seed run creates their €1 replacements.
//
//   npx tsx scripts/solidgate-archive-catalog-product.ts special_free addon_trial
//
// Requires SOLIDGATE_API_PUBLIC_KEY / SOLIDGATE_API_SECRET_KEY in the env.
// Product ids are resolved from the committed catalog-ids.json, and the
// product's live metadata.catalog_key is verified before archiving.

import dotenv from 'dotenv';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { SolidgateClient } from '../packages/shared/src/solidgate/client';

// Same key source as the seeder; already-exported env vars win over the file.
dotenv.config({ path: path.resolve(process.cwd(), 'apps/funnel/.env.local') });

const IDS_PATH = 'packages/shared/src/solidgate/catalog-ids.json';

type SolidgateProduct = { id: string; status?: string; metadata?: Record<string, string> };

// Same paginated listing the seeder uses — the only proven product read.
async function listProducts(client: SolidgateClient): Promise<SolidgateProduct[]> {
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

async function main() {
  const keysArg = process.argv.slice(2);
  if (keysArg.length === 0) {
    console.error('Naudojimas: npx tsx scripts/solidgate-archive-catalog-product.ts <catalog_key> [...]');
    process.exit(1);
  }
  if (!process.env.SOLIDGATE_API_PUBLIC_KEY || !process.env.SOLIDGATE_API_SECRET_KEY) {
    console.error('Truksta SOLIDGATE_API_PUBLIC_KEY / SOLIDGATE_API_SECRET_KEY env kintamuju');
    process.exit(1);
  }

  const catalogIds: Record<string, { product_id: string }> = JSON.parse(
    readFileSync(IDS_PATH, 'utf8'),
  );
  const client = new SolidgateClient({
    publicKey: process.env.SOLIDGATE_API_PUBLIC_KEY,
    secretKey: process.env.SOLIDGATE_API_SECRET_KEY,
  });

  const products = await listProducts(client);
  const byId = new Map(products.map((p) => [p.id, p]));

  let failed = 0;
  for (const key of keysArg) {
    const entry = catalogIds[key];
    if (!entry) {
      console.error(`FAIL  ${key}  nerastas ${IDS_PATH}`);
      failed++;
      continue;
    }
    try {
      const product = byId.get(entry.product_id);
      if (!product) {
        console.error(`FAIL  ${key}  ${entry.product_id} nerastas kanale (ar tikrai production raktai?)`);
        failed++;
        continue;
      }
      if (product.metadata?.catalog_key !== key) {
        console.error(
          `FAIL  ${key}  ${entry.product_id} metadata.catalog_key=${product.metadata?.catalog_key ?? 'nera'} — neatitinka, nieko nedarau`,
        );
        failed++;
        continue;
      }
      if (product.status === 'archived') {
        console.log(`SKIP  ${key}  ${entry.product_id} jau archived`);
        continue;
      }
      await client.request('subscriptions', `products/${entry.product_id}/archive`, {});
      console.log(`OK    ${key}  ${entry.product_id} archived`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${key}  ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }
  if (failed) process.exit(1);
  console.log('\nDabar paleisk: npx tsx scripts/solidgate-seed-catalog.ts --apply  (sukurs naujus €1 trial produktus ir atnaujins catalog-ids.json)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
