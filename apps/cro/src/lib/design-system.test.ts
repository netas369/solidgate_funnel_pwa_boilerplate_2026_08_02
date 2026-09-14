import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps the visual system from decaying back into ad-hoc values.
 *
 * The board this is ported from went through a pass that adopted a spacing and
 * type scale in the plan and then never used it, reaching for whatever Tailwind
 * number looked right at each call site. The result measured 20 distinct
 * spacing values with `py-3.5`, `py-3` and `py-2.5` on sibling rows, and 61 of
 * 69 text elements within two points of each other. Nothing lined up and the eye
 * had nothing to follow — which is most of what "doesn't look professional"
 * meant.
 *
 * Design constraints enforced by tests are an established pattern in this repo;
 * see packages/i18n/src/length-budgets.ts. Without one, this decays the next
 * time somebody needs "just a bit more room here".
 */

const SRC = join(__dirname, '..');

/**
 * The permitted spacing steps: 4, 8, 12, 16, 24, 32, 40, 48px.
 *
 * Eight steps consistently applied is what makes a grid look deliberate. A
 * hand-authored scale (4/8/12/18/26/40) cannot map onto Tailwind's linear
 * numbering, so this is the nearest honest equivalent.
 */
const ALLOWED_SPACING = new Set(['0', '1', '2', '3', '4', '6', '8', '10', '12']);

/** Fractional steps are the specific thing that produced misaligned rows. */
const SPACING_CLASS = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)\b/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles(join(SRC, 'app'));

describe('spacing vocabulary', () => {
  it('finds the app source', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('uses only the agreed spacing steps', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(SPACING_CLASS)) {
        if (!ALLOWED_SPACING.has(match[1]!)) {
          offenders.push(`${file.replace(SRC, '')}: ${match[0]}`);
        }
      }
    }
    // A fractional or off-scale step here means two panels' rows will not line
    // up. Pick the nearest allowed step instead.
    expect(offenders).toEqual([]);
  });
});

describe('colour discipline', () => {
  it('keeps the funnel mint out of the components', () => {
    // The board paints from --data (the funnel's deep green #166246) and marks
    // problems with --danger. The mint (#57cea8) is the funnel's ACTION colour
    // and is a FILL — 1.9:1 on white — so it can carry neither text nor a
    // hairline, and using it as a second data colour would put two greens on
    // the same chart for no reason a reader could name. The token exists in
    // globals.css so a future accent reaches for the right value; this keeps it
    // from drifting into use by accident.
    const uses = files.filter((file) =>
      /var\(--brand-mint\)|\bbg-brand\b|\btext-brand\b/.test(readFileSync(file, 'utf8')),
    );
    expect(uses).toEqual([]);
  });

  it('never hardcodes a hex colour in a component', () => {
    // Every colour must come from a token, or the light/dark split and any
    // future rebrand silently miss it.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${file.replace(SRC, '')}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never uses a stock Tailwind palette colour', () => {
    // The whole point of the token bridge is that this app paints from the
    // funnel's palette, not Tailwind's defaults.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const match = source.match(
        /\b(?:bg|text|border)-(?:neutral|slate|gray|zinc|stone|sky|red|amber|emerald|green|blue|indigo|violet)-\d{2,3}\b/,
      );
      if (match) offenders.push(`${file.replace(SRC, '')}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
