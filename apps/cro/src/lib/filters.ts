import { routing } from '@repo/i18n/routing';
import { QUIZ_VARIANT } from '@repo/shared/quiz-variant';

/**
 * The filters every screen shares, read from the URL.
 *
 * The URL is the source of truth rather than component state: an analyst can
 * bookmark "the German funnel over 90 days", paste it into a message, and it
 * survives the live board's auto-refresh.
 *
 * THREE DIMENSIONS, and two of them behave in opposite ways. carnivore-app has
 * only versions and glp-app only funnels; this board carries both, so the
 * distinction has to be explicit rather than assumed.
 */
export interface DashboardFilters {
  /**
   * Window length in days. Always populated — for a custom window it is the
   * derived span, so anything that just wants "how long a period is this"
   * needs no special case.
   */
  days: number;
  /**
   * A custom window, as calendar days in UTC: `from` and `to` are both
   * INCLUSIVE as displayed, and undefined for the rolling presets. Present
   * together or not at all.
   */
  from?: string;
  to?: string;
  /** undefined means every market. */
  locale?: string;
  /**
   * Which presentation/offer bucket. undefined means EVERY funnel variant, and
   * that is the resting state.
   *
   * Blending is CORRECT here. A funnel variant is a per-visitor A/B bucket that
   * shares one question set — same questions, same positions — and
   * assembleFunnelResponse merges them by step_id on purpose. Do not copy
   * glp-app's caveat about angles: its `funnel_angle` is a different quiz, this
   * is the same quiz presented differently.
   */
  funnelVariant?: string;
  /**
   * Which build of the quiz. undefined means EVERY version — a deliberate
   * opt-in rather than the resting state.
   *
   * REQUIRED but nullable, unlike the other two. For `locale` and
   * `funnelVariant`, absent and "all" mean the same thing, so an object that
   * forgets one still behaves like the default. Here they are OPPOSITES: the
   * default is ONE version, and absent would read as all of them. Making the
   * key mandatory forces every construction site to say which it means.
   *
   * Blending versions is dangerous in a way blending funnels is not — see
   * requiredQuizVersion().
   */
  quizVersion: string | undefined;
}

/** The searchParams shape every dashboard page accepts. */
export interface DashboardSearchParams {
  days?: string;
  from?: string;
  to?: string;
  locale?: string;
  /** Funnel variant. */
  f?: string;
  /** Quiz version. */
  v?: string;
  /** View state, not a filter. */
  step?: string;
  detail?: string;
  arms?: string;
}

const ALLOWED_LOCALES = new Set<string>(routing.locales as readonly string[]);

/** `?v=all` — the explicit opt-in to blending versions. */
export const ALL_VERSIONS = 'all';

/**
 * The longest window the picker offers.
 *
 * NOT a retention floor. carnivore-app and glp-app both name this
 * RETENTION_DAYS because a nightly cron prunes their quiz_step_events past 90
 * days; this schema has no such table and no prune job, so copying that name
 * would assert a data boundary that does not exist. It is purely a UX cap on
 * how long a window the picker will build, and raising it costs nothing but
 * query time.
 */
export const MAX_WINDOW_DAYS = 90;

const DEFAULT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Matches a well-formed variant code. Mirrors the DB's length CHECKs. */
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Today in UTC, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The earliest day the picker offers — its `min`, and the clamp. */
export function windowFloor(now: Date = new Date()): string {
  return new Date(now.getTime() - MAX_WINDOW_DAYS * MS_PER_DAY).toISOString().slice(0, 10);
}

function isCalendarDay(value: string | undefined): value is string {
  if (!value || !DATE_PATTERN.test(value)) return false;
  // Rejects 2026-02-31, which passes the pattern and would otherwise roll over
  // into March and silently shift the window.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days between two calendar days, inclusive of both ends. */
function spanDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.round(ms / MS_PER_DAY) + 1;
}

/**
 * Which quiz version the board reports on.
 *
 * DEFAULTS TO THE VERSION THIS BUILD SERVES, not to "everything". Questions get
 * cut, reordered and rewritten between versions, so a blended funnel averages
 * two different quizzes into a curve describing neither. An analyst arriving
 * with no opinion should see one quiz.
 *
 * `?v=all` asks for the blend anyway, which is worth having: it is how you see a
 * switchover day whole, and how you find rows from a version nobody remembers
 * deploying.
 *
 * A code merely UNKNOWN TO THIS BUILD but well-formed is honoured — a version
 * can outlive its registry entry and its rows are still in the table. A
 * malformed one falls back rather than erroring, matching how a bad locale is
 * treated: a mistyped URL should show the usual board, not an empty one that
 * reads as a quiet day.
 */
function parseQuizVersion(raw: string | undefined): string | undefined {
  if (raw === ALL_VERSIONS) return undefined;
  if (raw && VARIANT_PATTERN.test(raw)) return raw;
  return QUIZ_VARIANT;
}

/**
 * Which funnel variant. Absent means all of them, which is the resting state —
 * the inverse of the version rule above, because blending funnels is sound.
 */
function parseFunnelVariant(raw: string | undefined): string | undefined {
  if (!raw || raw === 'all') return undefined;
  return VARIANT_PATTERN.test(raw) ? raw : undefined;
}

export function parseFilters(
  params: DashboardSearchParams,
  now: Date = new Date(),
): DashboardFilters {
  // Validated against the routing locales so a hand-edited URL cannot push an
  // arbitrary string into an RPC — and so a typo shows every market rather than
  // silently returning an empty dashboard.
  const locale =
    params.locale && ALLOWED_LOCALES.has(params.locale) ? params.locale : undefined;
  const funnelVariant = parseFunnelVariant(params.f);
  const quizVersion = parseQuizVersion(params.v);

  const custom = parseCustomWindow(params.from, params.to, now);
  if (custom) return { ...custom, locale, funnelVariant, quizVersion };

  const requested = Number(params.days);
  const days = requested > 0 ? Math.min(requested, MAX_WINDOW_DAYS) : DEFAULT_DAYS;
  return { days, locale, funnelVariant, quizVersion };
}

/**
 * The version for a funnel-SHAPED tab. Never undefined.
 *
 * assembleFunnelResponse merges rows by step_id ALONE, keeping whichever row
 * arrived first for step_position, sort_index and label. Hand it two versions
 * where one moved a question and it produces a plausible chart with the wrong
 * position and the wrong label — no error, nothing to notice.
 *
 * So Overview and Drop-off call this instead of reading `quizVersion` directly,
 * and offer no "All versions" chip. Right now and Language & device are
 * per-session counts rather than per-position curves, so blending is safe there
 * and they may pass `allowBlend` to the filter bar.
 */
export function requiredQuizVersion(filters: DashboardFilters): string {
  return filters.quizVersion ?? QUIZ_VARIANT;
}

/**
 * A custom window, or null to fall back to the default preset.
 *
 * Every rejection falls back rather than erroring, matching how this module
 * treats a bad locale: a mistyped URL should show the usual board, never a
 * blank one that reads as a quiet day.
 */
function parseCustomWindow(
  rawFrom: string | undefined,
  rawTo: string | undefined,
  now: Date,
): { days: number; from: string; to: string } | null {
  if (!isCalendarDay(rawFrom) || !isCalendarDay(rawTo)) return null;

  const today = todayIso(now);
  const floor = windowFloor(now);

  // Clamped, not rejected: asking for more history than the picker offers is a
  // reasonable thing to try, and the honest response is the window that does
  // exist plus a note saying so — which is what wasClamped() drives on screen.
  const from = rawFrom < floor ? floor : rawFrom;
  const to = rawTo > today ? today : rawTo;
  if (from > to) return null;

  return { days: spanDays(from, to), from, to };
}

/** True when the requested start predates the cap, so the screen can say so. */
export function wasClamped(rawFrom: string | undefined, now: Date = new Date()): boolean {
  return isCalendarDay(rawFrom) && rawFrom < windowFloor(now);
}

/** The part of the filters that describes a period — all these two need. */
type PeriodFilters = Pick<DashboardFilters, 'days' | 'from' | 'to'>;

/** True when the filters describe a hand-picked window rather than a preset. */
export function isCustomRange(filters: PeriodFilters): boolean {
  return Boolean(filters.from && filters.to);
}

/**
 * How the period reads in a header: "Last 30 days", or "1–14 Aug 2026".
 *
 * A custom window collapses to one month name when both ends share it, because
 * "1 Aug 2026 – 14 Aug 2026" in a header line is mostly punctuation.
 */
export function rangeLabel(filters: PeriodFilters): string {
  if (!isCustomRange(filters)) return `Last ${filters.days} days`;

  const from = new Date(`${filters.from!}T00:00:00.000Z`);
  const to = new Date(`${filters.to!}T00:00:00.000Z`);
  const day = (d: Date) => String(d.getUTCDate());
  const monthYear = (d: Date) =>
    d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  if (filters.from === filters.to) return `${day(from)} ${monthYear(from)}`;
  if (monthYear(from) === monthYear(to)) return `${day(from)}–${day(to)} ${monthYear(to)}`;
  return `${day(from)} ${monthYear(from)} – ${day(to)} ${monthYear(to)}`;
}

/**
 * Rebuild a dashboard URL, preserving whatever is not being changed.
 *
 * Presets and custom windows are mutually exclusive, and CLEARING the other one
 * matters as much as setting this one: a `days` left beside a `from`/`to` would
 * be read by parseFilters as the custom window, and the preset link would
 * appear to do nothing.
 *
 * The three dimensions are written ASYMMETRICALLY, and that asymmetry is the
 * whole trick — `f` and `locale` are omitted at "all" because absent already
 * means all, while `v=all` must be written out because absent means the current
 * version instead.
 */
export function filterHref(
  basePath: string,
  filters: DashboardFilters,
  overrides: Partial<DashboardFilters> & {
    step?: string;
    detail?: string;
    /**
     * The quiz's BRANCH arms (two screens sharing one position), nothing to do
     * with an A/B arm — `funnelVariant` is what splits those.
     */
    arms?: string;
  } = {},
): string {
  const choosingPreset = overrides.days !== undefined;

  const next: DashboardFilters = {
    ...filters,
    ...overrides,
    ...(choosingPreset ? { from: undefined, to: undefined } : {}),
  };

  const search = new URLSearchParams();
  if (isCustomRange(next)) {
    search.set('from', next.from!);
    search.set('to', next.to!);
  } else if (next.days !== DEFAULT_DAYS) {
    // `days` is omitted at the default so the common URL stays clean.
    search.set('days', String(next.days));
  }
  if (next.locale) search.set('locale', next.locale);
  // Any value is written, because absent already means "all funnels" — there is
  // no default single funnel to omit against, unlike `v`.
  if (next.funnelVariant) search.set('f', next.funnelVariant);
  if (next.quizVersion === undefined) search.set('v', ALL_VERSIONS);
  else if (next.quizVersion !== QUIZ_VARIANT) search.set('v', next.quizVersion);
  if (overrides.step) search.set('step', overrides.step);
  if (overrides.detail) search.set('detail', overrides.detail);
  if (overrides.arms) search.set('arms', overrides.arms);

  const qs = search.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
