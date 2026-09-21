/**
 * Formatting shared by every screen, kept pure so the wording rules are
 * testable without rendering anything.
 *
 * The dashboard's audience is the CRO team, not engineers. Everything here
 * exists to keep database and statistics vocabulary off the screen — and to
 * keep the plainer wording from quietly overstating what was measured.
 */

/** Thresholds that drive BOTH the colour and the words, so they cannot disagree. */
const HEAVY_DROP_PCT = 25;
const NOTABLE_DROP_PCT = 10;

export type DropSeverity = 'heavy' | 'notable' | 'normal';

/**
 * How bad a drop-off is.
 *
 * One function rather than a threshold repeated in a `className` and again in a
 * label: the moment those drift, a row is tinted red while its badge says the
 * question is fine.
 */
export function dropSeverity(pct: number): DropSeverity {
  if (pct >= HEAVY_DROP_PCT) return 'heavy';
  if (pct >= NOTABLE_DROP_PCT) return 'notable';
  return 'normal';
}

/** Worded badge for a severity. Never colour alone — colour is not readable to everyone. */
export function severityLabel(severity: DropSeverity): string | null {
  if (severity === 'heavy') return 'Most people leave here';
  if (severity === 'notable') return 'Noticeable drop';
  return null;
}

/** 1204 → "1,204". */
export function formatPeople(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(n)));
}

/** 40.25 → "40%". Whole numbers only — a decimal implies precision the sample rarely has. */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

/**
 * Locale code → language name, e.g. 'zh-TW' → "Traditional Chinese".
 *
 * Intl.DisplayNames is built in, so this costs no dependency. Falls back to the
 * raw code rather than throwing: a retired or malformed locale sitting in
 * historical rows must not take the Segments screen down.
 */
export function languageName(locale: string | null | undefined): string {
  if (!locale) return 'Unknown';
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** Device class → label. Null means the request carried no User-Agent. */
export function deviceLabel(device: string | null | undefined): string {
  if (!device || device === 'unknown') return 'Unknown device';
  return device.charAt(0).toUpperCase() + device.slice(1);
}

/** Bar width as a percentage of the largest value, clamped so CSS can never receive a silly number. */
export function barWidthPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/**
 * Milliseconds → "1.4s" / "2m 05s", or an em dash when there is no reading.
 *
 * p50/p90 come back null when no answer on that question carried a duration.
 * "—" says "not measured"; a 0 would say "instant", which is a different and
 * wrong claim.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Seconds → "41s" / "3m 41s". Used by the live board's waiting time. */
export function formatWait(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}

/**
 * Signed change between two adjacent funnel rows, e.g. "−288".
 *
 * A true minus sign (U+2212), not a hyphen: at small sizes a hyphen next to a
 * digit reads as part of the number.
 */
export function formatChange(delta: number): string {
  if (delta === 0) return '';
  return delta < 0 ? `−${formatPeople(Math.abs(delta))}` : `+${formatPeople(delta)}`;
}

/**
 * Below this many people, percentages are too unstable to rank on.
 *
 * This is a correctness rule, not a cosmetic one. At 17 people a question where
 * 1 of 4 left scores 25% and outranks one where 3 of 17 left at 18% — but three
 * people is plainly the bigger loss. Ranking by percentage on a small sample
 * puts noise at the top of the "biggest losses" panel and sends someone off to
 * fix a question that is fine.
 */
export const SMALL_SAMPLE_PEOPLE = 30;

export function isSmallSample(peak: number): boolean {
  return peak < SMALL_SAMPLE_PEOPLE;
}

/**
 * Order rows worst-first: by percentage once there is enough traffic to trust
 * one, by absolute people lost while there is not.
 *
 * Generic over anything carrying the two numbers, so it works on an
 * AssembledStep without this module importing the assembler. The field names
 * are the assembler's on purpose — the reference boards called it
 * `droppedSessions` here and `dropped` there, and an adapter between two names
 * for one number is where a wrong column gets passed.
 */
export function rankByLoss<T extends { dropPct: number; dropped: number }>(
  rows: readonly T[],
  peak: number,
): T[] {
  const smallSample = isSmallSample(peak);
  return rows
    .slice()
    .sort((a, b) =>
      smallSample
        ? b.dropped - a.dropped || b.dropPct - a.dropPct
        : b.dropPct - a.dropPct || b.dropped - a.dropped,
    );
}
