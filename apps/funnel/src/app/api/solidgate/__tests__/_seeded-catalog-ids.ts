// Test fixture: a SEEDED catalog-ids.json.
//
// The boilerplate ships packages/shared/src/solidgate/catalog-ids.json scrubbed
// to empty strings — checkout is meant to fail loudly until you run
// `npx tsx scripts/solidgate-seed-catalog.ts --apply` against your own Solidgate
// merchant account. The payment-path suites need a seeded catalog to exercise
// anything past that guard, so they vi.mock the JSON module with this object.
//
// Keys and currency lists must mirror the real file; the values are obviously
// synthetic.

const CURRENCIES = [
  'eur',
  'usd',
  'czk',
  'huf',
  'ron',
  'twd',
  'ils',
  'pln',
  'dkk',
  'jpy',
] as const;

const CATALOG_KEYS = [
  'trial1',
  'trial2',
  'trial3',
  'trial4',
  'special_1eur',
  'special_free',
  'addon_trial',
  'addon_direct',
] as const;

export type SeededCatalogEntry = {
  product_id: string;
  prices: Record<string, string>;
};

export const SEEDED_CATALOG_IDS: Record<string, SeededCatalogEntry> =
  Object.fromEntries(
    CATALOG_KEYS.map((key) => [
      key,
      {
        product_id: `test-product-${key}`,
        prices: Object.fromEntries(
          CURRENCIES.map((currency) => [currency, `test-price-${key}-${currency}`]),
        ),
      },
    ]),
  );
