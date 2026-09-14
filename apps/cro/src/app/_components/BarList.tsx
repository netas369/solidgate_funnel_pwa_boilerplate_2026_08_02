import { barWidthPct, formatPeople } from '@/lib/presentation';

export interface BarItem {
  label: string;
  value: number;
  /** Right-hand annotation — a percentage, a duration, a count. */
  note?: string;
  /** Paints the bar with --danger. Reserved for something actually wrong. */
  alert?: boolean;
  /** Tooltip, for the machine identifier an engineer occasionally needs. */
  title?: string;
}

/**
 * The shared row visual. Two densities, because four panels rendering an
 * identical bar list is what made the page read as a list of lists.
 *
 *  - "bars"  label above a full-width bar; for comparing magnitudes
 *  - "rank"  numbered, one line, bar as a thin trailing track; for top-N lists
 *
 * Both sit on `.row`, so every panel's rows are the same height and their
 * numbers line up across the grid.
 */
export function BarList({
  items,
  max,
  variant = 'bars',
  formatValue = formatPeople,
}: {
  items: BarItem[];
  max: number;
  variant?: 'bars' | 'rank';
  formatValue?: (n: number) => string;
}) {
  if (variant === 'rank') {
    return (
      <ol>
        {items.map((item, index) => (
          <li key={item.label + item.title} className="row min-w-0 gap-3 px-4">
            <span className="w-4 shrink-0 text-xs tabular-nums text-ink-faint">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.title}>
              {item.label}
            </span>
            <span
              className="w-12 shrink-0 text-right text-sm font-medium tabular-nums"
              style={item.alert ? { color: 'var(--danger)' } : { color: 'var(--ink)' }}
            >
              {formatValue(item.value)}
            </span>
            {item.note !== undefined ? (
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                {item.note}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ul>
      {items.map((item) => (
        <li
          key={item.label + item.title}
          className="row min-w-0 flex-col justify-center gap-2 px-4 py-3"
        >
          {/* `w-full` here, NOT `items-stretch` on the <li>.
              `.row` is unlayered CSS and Tailwind's utilities sit in
              @layer utilities, so `.row { align-items: center }` beats an
              `items-stretch` class however the two are ordered — unlayered
              always wins over layered. In a flex-col container align-items is
              the HORIZONTAL axis, so this line was centred and sized to
              max-content rather than filling the row. With a `truncate` inside,
              max-content is the entire string: the longest quiz question (79
              chars) laid out 557px wide inside a 436px panel and spilled 61px
              out of each side, over the neighbouring tile. An explicit width is
              immune to align-items, so it cannot regress the same way. */}
          <div className="flex w-full min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.title}>
              {item.label}
            </span>
            <span className="shrink-0 text-sm font-medium tabular-nums text-ink">
              {formatValue(item.value)}
            </span>
            {item.note !== undefined ? (
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-faint">
                {item.note}
              </span>
            ) : null}
          </div>
          {/* Full row width, not squeezed beside the numbers. In a narrow
              three-column panel the bar was ~100px wide and communicated
              nothing — a bar that cannot show a proportion is decoration. */}
          <div className="h-1 w-full overflow-hidden funnel-bar--track">
            <div
              className={`funnel-bar ${item.alert ? 'funnel-bar--heavy' : ''}`}
              style={{ height: '100%', width: `${barWidthPct(item.value, max)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
