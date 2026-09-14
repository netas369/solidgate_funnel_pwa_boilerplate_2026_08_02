import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The load-bearing security property of this app, asserted mechanically.
 *
 * apps/cro reads quiz behaviour for an audience wider than the engineers who
 * own the payment code. "They see aggregates only" holds because the app has no
 * credential capable of anything else: it authenticates with the anon key plus
 * the analyst's JWT, RLS denies it every table, and the cro_* SECURITY DEFINER
 * functions return counts. A single `getSupabaseAdminClient()` import — added in
 * good faith to fetch one convenient thing — silently converts that database
 * guarantee into a promise, and nothing else in the build would notice.
 *
 * sessions.quiz_answers can hold special-category data under
 * docs/gdpr-compliance.md §2.5, so the failure mode is a data-protection
 * incident rather than a bug.
 *
 * Comments are allowed to mention the key (several explain precisely why it is
 * absent); code is not.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Crude but sufficient: drop // line comments and /* block comments. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('apps/cro holds no elevated database credential', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('no-service-role.test.ts'));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never imports the service-role admin client', () => {
    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /getSupabaseAdminClient|@repo\/shared\/supabase\/admin/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it('never reads SUPABASE_SERVICE_ROLE_KEY', () => {
    const offenders = files.filter((file) =>
      /SUPABASE_SERVICE_ROLE_KEY/.test(stripComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('reads quiz data only through cro_* RPCs, never a table', () => {
    // `.from('sessions')` would fail at runtime under RLS anyway — but
    // it would fail as an empty dashboard rather than an error, which is the
    // kind of bug that gets "fixed" by reaching for the service key.
    const offenders = files.filter((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /\.from\(\s*['"`](sessions|orders|funnel_events|quiz_definitions|quiz_definition_steps|quiz_definition_step_edges|cro_analysts|otp_attempts)['"`]/.test(
        code,
      );
    });
    expect(offenders).toEqual([]);
  });
});
