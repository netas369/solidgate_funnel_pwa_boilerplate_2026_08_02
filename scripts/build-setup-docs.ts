/** Local generation only; shared source keeps the app and Markdown prompts identical. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { integrationSteps } from '../apps/funnel/src/features/documentation/setup/integration-steps';
import { setupStepsNavigation } from '../apps/funnel/src/features/documentation/setup-navigation';

const check = process.argv.includes('--check');
const links = {
  '02': [['Solidgate produktai', 'https://docs.solidgate.com/billing/manage-products/products/'], ['Solidgate kainos', 'https://docs.solidgate.com/billing/manage-products/prices/'], ['Palaikomos valiutos', 'https://docs.solidgate.com/payments/payments-insights/supported-currencies/']],
  '03': [['Solidgate webhook', 'https://docs.solidgate.com/payments/integrate/webhooks/'], ['Supabase API sauga', 'https://supabase.com/docs/guides/api/securing-your-api']],
  '04': [['Solidgate Payment Form', 'https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/'], ['Solidgate mokėjimai išsaugota kortele', 'https://docs.solidgate.com/payments/card-payments/manage-card-payments/']],
  '05': [['Solidgate testiniai kortelių mokėjimai', 'https://docs.solidgate.com/payments/testing/card-payments/']],
} as const;
let failures = 0;
for (const step of integrationSteps) {
  const nav = setupStepsNavigation.find((item) => item.id === step.id);
  if (!nav || nav.href !== `/documentation/setup/${step.slug}`) throw new Error(`Navigation mismatch: ${step.id}`);
  const text = [
    `# ${step.id}. ${step.title}`,
    `Interaktyvus žingsnis ir kopijuojamas agento promptas: **\`${nav.href}\`**.`,
    step.description,
    'Šis puslapis aprašo būsimo agento darbą tiksliniame appso repo. Dokumentacijos UI generuoja instrukcijas; jis nevykdo providerio API, migracijų ar deploy. Įvesti laukai nepatvirtina failų egzistavimo ar integracijos parengties.',
    '## Reikalinga įvestis', step.inputs.map((item) => `- ${item}`).join('\n'),
    '## Žingsnio rezultatas', step.outputs.map((item) => `- ${item}`).join('\n'),
    ...step.sections.flatMap((section) => [`## ${section.title}`, section.body]),
    '## Užbaigimo patikros', step.checks.map((item) => `- ${item}`).join('\n'),
    '## Agento promptas',
    'Programėlės forma prideda bendras vykdymo taisykles ir įvestą projekto kontekstą. Kopijuojant vien šį dokumentą, agentui taip pat perduodamas target repo, app_key, aplinka, kanalas, konkreti catalog_version, provider_manifest_path ir main + OTO pasiūlymų planas. Paslapčių prie prompto nepridėkite. Kontekste nurodytas manifesto kelias pakeičia numatytą kelią visose instrukcijose; kitas kopijas kurti nereikia.',
    `\`\`\`text\n${step.prompt.trim()}\n\`\`\``,
    '## Pirminiai šaltiniai', links[step.id].map(([label, href]) => `- [${label}](${href})`).join('\n'),
    'Šis failas sugeneruotas iš `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Atnaujinti: `npm run docs:setup:build`. Patikrinti: `npm run docs:setup:check`.',
    '',
  ].join('\n\n');
  if (/\b(?:sk_(?:live|test)_|sb_secret_|eyJ[A-Za-z0-9_-]{25})/.test(text) || /\/Users\//.test(text)) throw new Error(`Potential private data: ${nav.source}`);
  const filename = resolve(nav.source);
  if (check) {
    let actual = ''; try { actual = readFileSync(filename, 'utf8'); } catch { /* Missing mirror is a failure. */ }
    if (actual !== text) { console.error(`Out of sync: ${nav.source}`); failures++; }
  } else {
    writeFileSync(filename, text);
  }
}
if (failures) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Generated'} ${integrationSteps.length} setup instructions; routes and copied prompt bodies share the same source.`);
