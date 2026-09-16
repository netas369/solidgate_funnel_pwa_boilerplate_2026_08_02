import { readFileSync, writeFileSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const evidence = dirname(fileURLToPath(import.meta.url));
const root = resolve(evidence, '../../..');
const recordedRoot = '/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02';
const scratch = mkdtempSync(join(tmpdir(), 'solidgate-audit-repro-'));
symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
const webhook = join(root, 'supabase/functions/solidgate-webhooks');
for (const name of ['orders', 'renewals']) {
  let source = readFileSync(join(evidence, `${name}-audit.test.ts.txt`), 'utf8')
    .replaceAll(recordedRoot, root);
  for (const module of ['_signature', '_codes', 'index']) {
    source = source.replaceAll(`from '../${module}'`, `from '${webhook}/${module}'`);
  }
  if (process.env.SOLIDGATE_AUDIT_CANONICAL_PRICE === '1') {
    // Existing unit fixtures inherited a 1767-cent USD quote. Confirm the
    // same monetary invariants using the boilerplate trial4 quote, 1700.
    const amounts = { 1767: 1700, 1267: 1200, 767: 700, 567: 500 };
    source = source.replace(/\b(1767|1267|767|567)\b/g, value => String(amounts[value]));
  }
  writeFileSync(join(scratch, `${name}.test.ts`), source);
}
writeFileSync(join(scratch, 'network-disabled.ts'),
  "globalThis.fetch = (() => { throw new Error('Audit reproduction: network disabled'); }) as typeof fetch;\n");
const config = {
  root: scratch,
  resolve: { alias: {
    'npm:@supabase/supabase-js@2': join(root, 'node_modules/@supabase/supabase-js'),
    'npm:posthog-node': join(root, 'apps/funnel/test-stubs/posthog-node.ts'),
  } },
  test: { environment: 'node', include: ['*.test.ts'], setupFiles: [join(scratch, 'network-disabled.ts')] },
};
writeFileSync(join(scratch, 'vitest.config.mts'), `export default ${JSON.stringify(config, null, 2)};\n`);
console.log('Isolated reproductions. Network disabled. Expected on audited code: 14 assertion failures.');
console.log('Temporary harness:', scratch);
const tests = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(scratch, 'vitest.config.mts')], { cwd: root, stdio: 'inherit' });
let proofFailed = false;
for (const proof of ['checkout-proof.cjs', 'card-update-proof.cjs', 'reporting-proof.cjs']) {
  const source = readFileSync(join(evidence, proof), 'utf8').replaceAll(recordedRoot, root);
  const path = join(scratch, proof);
  writeFileSync(path, source);
  const result = spawnSync(process.execPath, [path], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) proofFailed = true;
}
console.log('Assertions in .test.ts describe correct desired behavior and intentionally fail until fixes.');
console.log('The .cjs diagnostic proofs assert the observed faulty behavior and pass on audited code.');
process.exitCode = proofFailed ? 2 : (tests.status ?? 2);
