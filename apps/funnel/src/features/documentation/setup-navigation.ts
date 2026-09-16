import type { DocumentationMetadata } from './components/types';

/** Setup is an interactive route, kept outside the historical reader manifest. */
export const setupNavigation = {
  title: 'Naujo appso instrukcijos',
  shortTitle: 'Instrukcijos',
  stepTitle: '01. Produktų kūrimas',
  description: 'Penki nuoseklūs promptai: produktai, katalogas ir OTO, DB bei webhook, checkout ir pilna sandbox patikra.',
  href: '/documentation/setup',
} as const;

export const setupSearchDocument: DocumentationMetadata = {
  slug: 'setup',
  title: setupNavigation.title + ': produktų kūrimas',
  description: 'Agento promptas, app_key, PRODNAME, offer_key ir product_slug, Hub Name, Public description, Descriptor, transakcijos metadata ir UTM, valiutų kainos bei pirkimo locale.',
  group: 'setup',
  source: 'docs/solidgate/setup/01-product-creation.lt.md',
  updatedAt: '2026-09-15',
  status: 'current',
  headings: [
    { id: 'setup-field-guide', text: 'Laukų žodynas: app_key, PRODNAME, offer_key, Name ir Public description', level: 2 },
    { id: 'setup-transaction-example', text: 'Hub produktas, transakcijos metadata, Descriptor ir UTM', level: 2 },
    { id: 'setup-fields', text: 'Produkto laukai ir produkto kodo formatas', level: 2 },
    { id: 'setup-locales', text: 'Svetainės URL locale, valiutos ir kainos', level: 2 },
    { id: 'setup-currencies', text: 'TWD, JPY ir mažiausi valiutos vienetai', level: 2 },
    { id: 'setup-prompt', text: 'Kopijuojamas produktų kūrimo promptas agentui', level: 2 },
  ],
};


export const setupStepsNavigation = [
  { id: '01', title: 'Produktų kūrimas', shortTitle: 'Produktai', href: '/documentation/setup', slug: 'setup', source: 'docs/solidgate/setup/01-product-creation.lt.md', description: setupSearchDocument.description },
  { id: '02', title: 'Katalogas ir OTO', shortTitle: 'Katalogas', href: '/documentation/setup/catalog-integration', slug: 'setup/catalog-integration', source: 'docs/solidgate/setup/02-catalog-integration.lt.md', description: 'Visas main ir OTO pasiūlymų sąrašas, produktų manifestas, kainos, entitlement, viena OTO2 prenumerata ir vienkartiniai pirkimai.' },
  { id: '03', title: 'DB ir webhook', shortTitle: 'DB ir webhook', href: '/documentation/setup/database-webhooks', slug: 'setup/database-webhooks', source: 'docs/solidgate/setup/03-database-webhooks.lt.md', description: 'Mokėjimų apskaita, order ir invoice, trial, renewal, refund, cancellation, pasikartojantys webhook, metadata ir UTM.' },
  { id: '04', title: 'Checkout ir OTO', shortTitle: 'Checkout', href: '/documentation/setup/checkout-oto', slug: 'setup/checkout-oto', source: 'docs/solidgate/setup/04-checkout-oto.lt.md', description: 'Main checkout ir OTO seka, išsaugotas mokėjimo būdas, 3DS, auth, prieiga, URL locale ir mokėjimo būsenos.' },
  { id: '05', title: 'Sandbox patikra', shortTitle: 'Patikra', href: '/documentation/setup/sandbox-verification', slug: 'setup/sandbox-verification', source: 'docs/solidgate/setup/05-sandbox-verification.lt.md', description: 'Pilna sandbox mokėjimų patikra: sėkmė, klaidos, dvigubi paspaudimai, retry, renewal, refund ir suderinta pinigų apskaita.' },
] as const;

export const setupSearchDocuments: DocumentationMetadata[] = [
  setupSearchDocument,
  ...setupStepsNavigation.slice(1).map((step) => ({
    slug: step.slug,
    title: `${step.id}. ${step.title}`,
    description: step.description,
    group: 'setup',
    source: step.source,
    updatedAt: '2026-09-15',
    status: 'current' as const,
    headings: [
      { id: 'integration-handoff', text: 'Ko reikia pradžioje ir ką perduoti kitam žingsniui', level: 2 },
      { id: 'integration-context', text: 'Bendri appso laukai ir išsaugotas integracijos planas', level: 2 },
      { id: 'integration-offers', text: 'Main ir OTO pasiūlymai, mokėjimo tipai ir prieiga', level: 2 },
      { id: 'integration-instructions', text: `${step.title}: instrukcijos ir taisyklės`, level: 2 },
      { id: 'integration-checks', text: 'Priėmimo kriterijai ir patikros įrodymai', level: 2 },
      { id: 'integration-prompt', text: `${step.id} kopijuojamas agento promptas`, level: 2 },
    ],
  })),
];
