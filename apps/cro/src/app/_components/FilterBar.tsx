import Link from 'next/link';
import { segmentLabel } from '@repo/shared/cro/segment-labels';
import { QUIZ_VARIANT } from '@repo/shared/quiz-variant';
import { filterHref, isCustomRange, type DashboardFilters } from '@/lib/filters';
import { formatPeople } from '@/lib/presentation';
import type { SegmentOptionRow } from '@/lib/queries';
import { CustomRange } from './CustomRange';

/**
 * Every filter on the board, in one labelled block.
 *
 * The reference boards began as sibling pickers in a flex row, which put
 * different DIMENSIONS into one undifferentiated run of chips: funnel chips ran
 * straight into market chips with nothing between them, and two active
 * selections from two groups read as one. Labelling each row is what makes it
 * scannable — the chips cannot say which question they answer.
 *
 * ── THE TWO AXES ARE NOT SYMMETRICAL ───────────────────────────────────────
 *
 * Funnel: "All" is the resting state, and blending is CORRECT. A funnel variant
 * is a presentation/offer A/B bucket over ONE question set, so the positions
 * line up and assembleFunnelResponse merges them on purpose.
 *
 * Version: one version is the resting state, and "All" is offered only where
 * `allowBlend` is passed. Two versions ask different questions and number them
 * differently, so on the funnel-shaped tabs a blended curve describes neither —
 * and worse, the assembler merges by step_id alone and would keep whichever
 * row arrived first for the position and the label.
 */
export function FilterBar({
  filters,
  basePath,
  segments,
  allowBlend = false,
  showPeriod = true,
}: {
  filters: DashboardFilters;
  basePath: string;
  segments: SegmentOptionRow[];
  /**
   * Offer an "All versions" chip. Only for tabs that count SESSIONS rather than
   * draw a per-position curve — Right now, Language & device. Never Overview or
   * Drop-off.
   */
  allowBlend?: boolean;
  /**
   * Offer a date range. False on the live tab, which always reports the last
   * fifteen minutes — a period control there is a visible lie about what the
   * numbers cover.
   */
  showPeriod?: boolean;
}) {
  const funnels = segments.filter((s) => s.kind === 'funnel');
  const versions = segments.filter((s) => s.kind === 'version');
  const locales = segments.filter((s) => s.kind === 'locale');

  return (
    <div className="card px-4 py-3">
      <div className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: 'auto minmax(0, 1fr)' }}>
        {offersChoice(funnels, filters.funnelVariant) && (
          <Row label="Funnel">
            <Chip
              href={filterHref(basePath, filters, { funnelVariant: undefined })}
              active={!filters.funnelVariant}
              label="All"
              count={funnels.reduce((sum, f) => sum + f.sessions, 0)}
              title="Offer variants share one question set, so combining them is sound"
            />
            {funnels.map((option) => (
              <Chip
                key={option.id}
                href={filterHref(basePath, filters, { funnelVariant: option.id })}
                active={filters.funnelVariant === option.id}
                label={segmentLabel('funnel', option.id).label}
                count={option.sessions}
              />
            ))}
          </Row>
        )}

        {offersChoice(versions, filters.quizVersion ?? QUIZ_VARIANT) && (
          <Row label="Quiz">
            {versions.map((option) => {
              const named = segmentLabel('version', option.id);
              return (
                <Chip
                  key={option.id}
                  href={filterHref(basePath, filters, { quizVersion: option.id })}
                  active={filters.quizVersion === option.id}
                  label={named.label}
                  count={option.sessions}
                  // The note is what makes a comparison months later legible:
                  // "v2 vs v3" says nothing, "added the intro split" does.
                  title={named.note}
                />
              );
            })}
            {allowBlend && (
              <Chip
                href={filterHref(basePath, filters, { quizVersion: undefined })}
                active={filters.quizVersion === undefined}
                label="All"
                count={versions.reduce((sum, v) => sum + v.sessions, 0)}
                title="Question numbers do not line up between versions"
              />
            )}
          </Row>
        )}

        {offersChoice(locales, filters.locale) && (
          <Row label="Market">
            <Chip
              href={filterHref(basePath, filters, { locale: undefined })}
              active={!filters.locale}
              label="All"
              count={locales.reduce((sum, l) => sum + l.sessions, 0)}
            />
            {locales.map((option) => (
              <Chip
                key={option.id}
                href={filterHref(basePath, filters, { locale: option.id })}
                active={filters.locale === option.id}
                label={segmentLabel('locale', option.id).label}
                count={option.sessions}
              />
            ))}
          </Row>
        )}

        {showPeriod && (
        <Row label="Period">
          {[7, 30, 90].map((days) => (
            <Chip
              key={days}
              href={filterHref(basePath, filters, { days })}
              active={!isCustomRange(filters) && filters.days === days}
              label={`${days} days`}
            />
          ))}
          <span className="mx-1 self-center text-xs" style={{ color: 'var(--ink-faint)' }}>
            or
          </span>
          <CustomRange filters={filters} basePath={basePath} />
        </Row>
        )}
      </div>
    </div>
  );
}

/**
 * Should this row render at all?
 *
 * Subtler than `length > 1`. One option that is ALREADY selected is not a
 * filter, it is a row of noise restating what the board shows. But one option
 * that is NOT selected must still render — that is a freshly deployed version
 * with no rows yet, and hiding it leaves the analyst no way back to the one
 * that has them.
 */
function offersChoice(options: SegmentOptionRow[], selected: string | undefined): boolean {
  if (options.length === 0) return false;
  if (options.length > 1) return true;
  return options[0]!.id !== selected;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      {/* Top-aligned, not centred: a row that wraps (the period row on a narrow
          screen) would otherwise float its label into the gap between the two
          lines. pt-2 matches the chips' own vertical padding so the label sits
          on the first chip's text baseline. */}
      <div className="label-eyebrow self-start whitespace-nowrap pt-2">{label}</div>
      <nav className="flex flex-wrap items-center gap-1" aria-label={label}>
        {children}
      </nav>
    </>
  );
}

function Chip({
  href,
  active,
  label,
  count,
  title,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
  title?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      title={title}
      className="rounded-md px-3 py-2 text-xs font-medium transition-colors"
      style={
        active
          ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
          : { background: 'var(--paper-soft)', color: 'var(--ink-soft)' }
      }
    >
      {label}
      {count !== undefined && (
        <span className="ml-2 tabular-nums" style={{ opacity: 0.6 }}>
          {formatPeople(count)}
        </span>
      )}
    </Link>
  );
}
