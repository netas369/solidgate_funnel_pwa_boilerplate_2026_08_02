import type { FunnelView } from '@/lib/funnel';

/**
 * What the numbers on this screen cannot be trusted to mean.
 *
 * The assembler raises these; neither reference board renders them, because
 * neither has them. That is the failure mode worth designing against here — a
 * board whose catalog was never published shows raw step ids next to perfectly
 * confident percentages, and nothing on screen says why.
 *
 * Rendered ABOVE the data rather than as a footnote: a caveat under a chart is
 * read after the reader has already believed the chart.
 */
const ADVICE: Record<string, string> = {
  CATALOG_NOT_PUBLISHED: 'Run `npx tsx scripts/publish-quiz-definition.ts --apply`.',
  SMALL_SAMPLE: 'Problems are ranked by people lost rather than by percentage until then.',
  RETIRED_STEPS:
    'They are listed at the bottom, without a position — the quiz has no slot for them any more.',
};

export function Warnings({ warnings }: { warnings: FunnelView['warnings'] }) {
  if (warnings.length === 0) return null;

  return (
    <div className="space-y-2">
      {warnings.map((warning) => (
        <div
          key={warning.code}
          role="status"
          className="card border-l-4 p-4 text-sm"
          style={{ borderLeftColor: 'var(--ink-faint)' }}
        >
          <p className="text-ink">{warning.message}</p>
          {ADVICE[warning.code] ? (
            <p className="mt-1 text-xs text-ink-soft">{ADVICE[warning.code]}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
