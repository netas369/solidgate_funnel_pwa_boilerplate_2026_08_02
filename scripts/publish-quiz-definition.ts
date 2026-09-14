// Publish the TypeScript quiz definition into Postgres for the CRO dashboard.
//
//   npx tsx scripts/publish-quiz-definition.ts            # dry run (default)
//   npx tsx scripts/publish-quiz-definition.ts --apply    # write to Postgres
//   npx tsx scripts/publish-quiz-definition.ts --verify   # read back, diff
//
//   --app-key <key>     defaults to $CRO_APP_KEY or 'boilerplate'
//   --funnel-key <key>  defaults to $CRO_FUNNEL_KEY or 'main'
//
// WHY: an external CRO dashboard reading this app's database sees
// funnel_events.step_number and sessions.step_activity keys, with no way to
// learn what those steps ARE — the quiz graph lives only in TypeScript. This
// publishes it so steps can be labelled and a BRANCH told apart from a DROP.
//
// Run it BEFORE deploying an app whose QUIZ_VARIANT is new, or the dashboard
// collects metrics it cannot label. It writes no user data.

import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  buildDefinitionSnapshot,
  diffStepRows,
  type DefinitionSnapshot,
  type PublishedStepRow,
} from './publish-quiz-definition-lib';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/funnel/.env.local') });

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const APP_KEY = flagValue('--app-key', process.env.CRO_APP_KEY ?? 'boilerplate');
const FUNNEL_KEY = flagValue('--funnel-key', process.env.CRO_FUNNEL_KEY ?? 'main');

// Untyped client ON PURPOSE. getSupabaseAdminClient() is createClient<Database>,
// and Database has no quiz_definitions until packages/shared/src/types/
// database.ts is regenerated — which cannot happen until the migration is
// applied, which is what this script exists to exercise. Untyped breaks the
// cycle. Same approach as solidgate-reconcile-payment-identities.ts.
function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (apps/funnel/.env.local)',
    );
    process.exit(1);
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Loaded dynamically: quiz-config.ts runs quizConfigSchema.parse at module
// load, so a top-level import turns a malformed config into a raw zod stack
// trace before any of the messages above have had a chance to print.
async function loadConfig() {
  try {
    const [config, definition, messages] = await Promise.all([
      import('../apps/funnel/src/features/quiz/config/quiz-config'),
      import('../apps/funnel/src/features/quiz/server/quiz-definition'),
      // Every string in quiz-config.ts is an i18n KEY, not a sentence. Without
      // the message pack the catalog would publish 'steps.step1.question' as a
      // step's name, which is no more readable in a dashboard than 'step1'.
      import('../packages/i18n/messages/en/quiz.json', { with: { type: 'json' } }),
    ]);
    return {
      quizConfig: config.quizConfig,
      firstStepId: config.FIRST_STEP_ID,
      terminalTypes: config.TERMINAL_STEP_TYPES,
      quizVariant: definition.QUIZ_VARIANT,
      messages: (messages as { default?: unknown }).default ?? messages,
    };
  } catch (error) {
    console.error('Quiz config failed to parse — fix quiz-config.ts before publishing.\n', error);
    process.exit(1);
  }
}

function printSteps(snapshot: DefinitionSnapshot): void {
  for (const step of snapshot.steps) {
    const targets = step.next.map((edge) => edge.to_step_id);
    const unique = [...new Set(targets)];
    const arrow = step.is_terminal
      ? 'TERMINAL'
      : `→ ${unique.join(' | ') || '(none)'}`;
    const notes = [
      unique.length > 1 ? 'BRANCH' : '',
      step.is_unconditional ? '' : 'SOME VISITORS ONLY',
      step.shares_position_with.length > 0
        ? `shares pos → ${step.shares_position_with.join(', ')}`
        : '',
      step.reachable ? '' : 'UNREACHABLE',
    ]
      .filter(Boolean)
      .join('  ');
    console.log(
      `▸ ${step.step_id.padEnd(8)} pos ${String(step.position).padEnd(3)} ` +
        `${step.step_type.padEnd(18)} ${(step.is_question ? 'question' : 'screen').padEnd(9)} ` +
        `${(step.label ?? step.store_as ?? '—').slice(0, 34).padEnd(36)} ` +
        `${arrow.padEnd(20)} ${notes}`,
    );
  }
}

async function readPublished(
  supabase: ReturnType<typeof client>,
  quizVariant: string,
): Promise<{ header: Record<string, unknown> | null; steps: PublishedStepRow[] }> {
  const { data: header, error: headerError } = await supabase
    .from('quiz_definitions')
    .select('quiz_variant, app_key, funnel_key, first_step_id, total_steps, config_hash, published_at')
    .eq('quiz_variant', quizVariant)
    .maybeSingle();
  if (headerError) throw new Error(`quiz_definitions read failed: ${headerError.message}`);
  if (!header) return { header: null, steps: [] };

  const { data: steps, error: stepsError } = await supabase
    .from('quiz_definition_steps')
    .select(
      'step_id, position, sort_index, step_type, phase_key, store_as, is_question, is_terminal, answer_keys, option_values, option_labels, label_key, label, is_unconditional, entry_skippable',
    )
    .eq('quiz_variant', quizVariant)
    .order('sort_index', { ascending: true });
  if (stepsError) throw new Error(`quiz_definition_steps read failed: ${stepsError.message}`);

  const { data: edges, error: edgesError } = await supabase
    .from('quiz_definition_step_edges')
    .select('from_step_id, to_step_id, on_value, edge_index')
    .eq('quiz_variant', quizVariant)
    .order('edge_index', { ascending: true });
  if (edgesError) throw new Error(`quiz_definition_step_edges read failed: ${edgesError.message}`);

  const rows: PublishedStepRow[] = (steps ?? []).map((step) => ({
    step_id: step.step_id as string,
    position: step.position as number,
    sort_index: step.sort_index as number,
    step_type: step.step_type as string,
    phase_key: (step.phase_key as string | null) ?? null,
    store_as: (step.store_as as string | null) ?? null,
    is_question: Boolean(step.is_question),
    is_terminal: Boolean(step.is_terminal),
    answer_keys: (step.answer_keys as string[]) ?? [],
    option_values: (step.option_values as string[]) ?? [],
    option_labels: (step.option_labels as Record<string, string>) ?? {},
    label_key: (step.label_key as string | null) ?? null,
    label: (step.label as string | null) ?? null,
    is_unconditional: Boolean(step.is_unconditional),
    entry_skippable: Boolean(step.entry_skippable),
    next: (edges ?? [])
      .filter((edge) => edge.from_step_id === step.step_id)
      .map((edge) => ({
        to_step_id: edge.to_step_id as string,
        on_value: (edge.on_value as string | null) ?? null,
      })),
    shares_position_with: [],
    reachable: true,
  }));

  return { header: header as Record<string, unknown>, steps: rows };
}

async function main(): Promise<void> {
  const { quizConfig, firstStepId, terminalTypes, quizVariant, messages } = await loadConfig();
  const snapshot = buildDefinitionSnapshot(quizConfig as never, {
    quizVariant,
    appKey: APP_KEY,
    funnelKey: FUNNEL_KEY,
    firstStepId,
    terminalTypes,
    messages,
  });

  const mode = VERIFY ? 'VERIFY' : APPLY ? 'APPLY (writing)' : 'DRY RUN';
  console.log(`Quiz definition publisher — ${mode}`);
  console.log(`App:    ${APP_KEY}   Funnel: ${FUNNEL_KEY}   Quiz: ${quizVariant}`);
  console.log(
    `Config: ${snapshot.config_hash.slice(0, 12)}…   ` +
      `${snapshot.steps.length} steps · ${snapshot.total_steps} positions\n`,
  );
  printSteps(snapshot);
  console.log('');

  const unlabelled = snapshot.steps.filter((step) => !step.label);
  if (unlabelled.length > 0) {
    // Not fatal — a step can legitimately have no copy of its own — but the CRO
    // dashboard will fall back to the raw step id for these rows.
    console.warn(
      `⚠ no label resolved for: ${unlabelled.map((s) => s.step_id).join(', ')}`,
    );
  }

  const unreachable = snapshot.steps.filter((step) => !step.reachable);
  if (unreachable.length > 0) {
    // A warning, never an error: a step no longer on any path may still have
    // historical sessions and must remain publishable.
    console.warn(
      `⚠ unreachable from ${firstStepId}: ${unreachable.map((s) => s.step_id).join(', ')}`,
    );
  }

  const supabase = client();

  if (VERIFY) {
    const { header, steps } = await readPublished(supabase, quizVariant);
    if (!header) {
      console.error(`✗ ${quizVariant} is not published`);
      process.exit(1);
    }
    let failures = 0;
    if (header.config_hash !== snapshot.config_hash) {
      console.error(`✗ config_hash ${String(header.config_hash).slice(0, 12)}… ≠ ${snapshot.config_hash.slice(0, 12)}…`);
      failures += 1;
    }
    for (const diff of diffStepRows(steps, snapshot.steps)) {
      console.error(
        `✗ ${diff.step_id.padEnd(8)} ${diff.change}${diff.fields ? `: ${diff.fields.join(', ')}` : ''}`,
      );
      failures += 1;
    }
    if (failures === 0) console.log(`✓ ${quizVariant} matches the published definition`);
    process.exit(failures ? 1 : 0);
  }

  if (!APPLY) {
    const { header } = await readPublished(supabase, quizVariant);
    if (!header) {
      console.log(`▸ ${quizVariant}  CREATE + ${snapshot.steps.length} step rows`);
    } else if (header.config_hash === snapshot.config_hash) {
      console.log(`✓ ${quizVariant}  already published, unchanged`);
    } else {
      console.error(
        `✗ ${quizVariant} already published as ${String(header.config_hash).slice(0, 12)}…\n` +
          `  This run computes ${snapshot.config_hash.slice(0, 12)}….\n` +
          `  A published definition is IMMUTABLE — historical step_activity keys and\n` +
          `  funnel_events.step_number are interpreted against it. Bump QUIZ_VARIANT in\n` +
          `  apps/funnel/src/features/quiz/server/quiz-definition.ts and re-run.`,
      );
      process.exit(1);
    }
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  const { data, error } = await supabase.rpc('publish_quiz_definition', {
    p_quiz_variant: snapshot.quiz_variant,
    p_app_key: snapshot.app_key,
    p_funnel_key: snapshot.funnel_key,
    p_first_step_id: snapshot.first_step_id,
    p_total_steps: snapshot.total_steps,
    p_config_hash: snapshot.config_hash,
    p_steps: snapshot.steps.map((step) => ({
      step_id: step.step_id,
      position: step.position,
      sort_index: step.sort_index,
      step_type: step.step_type,
      phase_key: step.phase_key,
      store_as: step.store_as,
      is_question: step.is_question,
      is_terminal: step.is_terminal,
      answer_keys: step.answer_keys,
      option_values: step.option_values,
      option_labels: step.option_labels,
      label_key: step.label_key,
      label: step.label,
      is_unconditional: step.is_unconditional,
      entry_skippable: step.entry_skippable,
      next: step.next,
    })),
  });

  if (error) {
    if (error.message.includes('QUIZ_DEFINITION_DRIFT')) {
      console.error(
        `✗ ${quizVariant} is already published with a DIFFERENT structure.\n` +
          `  ${error.message}\n` +
          `  Bump QUIZ_VARIANT in apps/funnel/src/features/quiz/server/quiz-definition.ts\n` +
          `  and re-run. Every quiz change gets its own version.`,
      );
    } else {
      console.error(`✗ publish failed: ${error.message}`);
    }
    process.exit(1);
  }

  const result = data as { result?: string; steps?: number } | null;
  console.log(
    result?.result === 'unchanged'
      ? `✓ ${quizVariant}  already published, unchanged — nothing written`
      : `✓ ${quizVariant}  published with ${result?.steps ?? snapshot.steps.length} step rows`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
