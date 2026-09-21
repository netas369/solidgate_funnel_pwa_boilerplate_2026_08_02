import { dropSeverity, formatPct, formatPeople } from '@/lib/presentation';
import type { AssembledPosition } from '@repo/shared/cro/funnel-response';

/**
 * How many people are still in the quiz, question by question.
 *
 * The line is the funnel's GREEN. Red appears at exactly one place — the marked
 * cliff — so it means "look here" rather than "this is a chart".
 *
 * Inline SVG, no chart library: the CSP forbids external scripts, and this is a
 * line with two axes.
 *
 * THREE THINGS HERE WERE LEARNED BY LOOKING AT A SCREENSHOT, not by reasoning:
 *
 *  1. The SVG scales uniformly with its viewBox, so a `fontSize` is in viewBox
 *     units, NOT pixels. 18 looked reasonable in the source and rendered as
 *     enormous chrome that dwarfed the data. The values below are tuned for a
 *     ~900px-wide panel, where the viewBox scale is roughly 0.9.
 *  2. Axis ticks must be ROUND numbers. Slicing the maximum into fifths gave
 *     "1,204 / 903 / 602 / 301", which is unreadable — an axis is a ruler and a
 *     ruler has round markings.
 *  3. Below a certain traffic level a line chart is noise. Four people zig-
 *     zagging between 2 and 4 draws a dramatic-looking cliff that means nothing,
 *     so under MIN_PEOPLE_FOR_CHART this says so instead of drawing it.
 *
 * The Y axis starts at zero on purpose. Cropping it would exaggerate every
 * decline — the classic way a funnel chart flatters or panics its reader.
 */

const W = 1000;
const H = 300;
const PAD_L = 78;
const PAD_R = 24;
const PAD_T = 26;
const PAD_B = 54;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

/** Tuned against a rendered screenshot at ~900px panel width, not guessed. */
const FONT_TICK = 13;
const FONT_AXIS_TITLE = 12;
const FONT_CALLOUT = 14;

const X_LABEL_TARGET = 6;
const Y_TICK_TARGET = 5;

/**
 * Under this many people the curve is a small sample and individual visitors
 * move it visibly. That earns a CAVEAT, not a blank panel.
 *
 * This was briefly a threshold that replaced the chart with a message, which
 * was the wrong call twice over: the whole point of the panel is the shape, and
 * on a real dataset of 17 people it silently deleted the feature. A chart with
 * few data points is still the honest picture of those points.
 */
const SMALL_SAMPLE = 25;

/** Round axis step: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(rawMax: number, tickCount: number): number {
  const rough = rawMax / tickCount;
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  // 2.5 is on the ladder because without it a peak of 1,204 rounds the axis up
  // to 1,500 and a fifth of the panel's height is empty.
  const factor =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return factor * magnitude;
}

/**
 * One point per POSITION, never per screen. Branch and follow-up screens share
 * their question's slot, so plotting them would put two points on one x and draw
 * a spike where the quiz merely showed a second card.
 */
export function FunnelChart({
  rows: allRows,
  finished,
}: {
  rows: AssembledPosition[];
  /**
   * totals.finished from the assembler, passed in rather than derived here.
   * It is NOT the last plotted row: in a window where nobody got past question
   * 19, "the last row" is question 19, and describing its answers as the finish
   * would flatter the funnel badly.
   */
  finished: number;
}) {
  // Retired questions have no place on the funnel's shape — they are not a slot
  // anyone walks through any more.
  const rows = allRows.filter((r) => !r.retired);
  if (rows.length === 0) return null;

  const peak = Math.max(...rows.map((r) => r.reached), 0);

  const step = niceStep(peak, Y_TICK_TARGET);
  // Round the top UP to a whole step so the axis ends on a round number and the
  // line never touches the ceiling.
  const axisMax = Math.ceil(peak / step) * step;
  const n = rows.length;

  const x = (index: number) =>
    n === 1 ? PAD_L + INNER_W / 2 : PAD_L + (index / (n - 1)) * INNER_W;
  const y = (value: number) => PAD_T + INNER_H - (value / axisMax) * INNER_H;

  const points = rows.map((row, i) => ({ row, cx: x(i), cy: y(row.reached) }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx} ${p.cy}`).join(' ');
  const area = `${line} L ${points[points.length - 1]!.cx} ${PAD_T + INNER_H} L ${points[0]!.cx} ${PAD_T + INNER_H} Z`;

  const ticks: number[] = [];
  for (let value = 0; value <= axisMax; value += step) ticks.push(value);

  const labelEvery = Math.max(1, Math.ceil(n / X_LABEL_TARGET));

  // The one question worth pointing at. Same traffic floor the ranked panels
  // use, so a question three people saw cannot claim the callout.
  const worst = rows
    .filter(
      (r) =>
        r.reached >= Math.min(20, Math.max(3, Math.round(peak * 0.5))) &&
        dropSeverity(r.lead.dropPct) === 'heavy',
    )
    .reduce<AssembledPosition | null>(
      (acc, r) => (acc === null || r.lead.dropPct > acc.lead.dropPct ? r : acc),
      null,
    );
  // Keyed on position, not step id: the marked point is a slot on this axis.
  const worstPoint = worst ? (points.find((p) => p.row.position === worst.position) ?? null) : null;
  // Flip the callout to the left of the marker when it would run off the edge.
  const calloutFlips = worstPoint ? worstPoint.cx > W - PAD_R - 240 : false;

  return (
    <div className="px-4 pb-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`How many people are still in the quiz at each question. ${formatPeople(
          rows[0]!.reached,
        )} reach the first question and ${formatPeople(finished)} reach the end.`}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--hairline)"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 12}
              y={y(value) + 4}
              textAnchor="end"
              fontSize={FONT_TICK}
              fill="var(--ink-soft)"
            >
              {formatPeople(value)}
            </text>
          </g>
        ))}

        <text
          x={PAD_L - 12}
          y={PAD_T - 10}
          textAnchor="end"
          fontSize={FONT_AXIS_TITLE}
          fill="var(--ink-soft)"
        >
          people
        </text>

        <path d={area} fill="var(--data)" opacity={0.08} />
        <path
          d={line}
          fill="none"
          stroke="var(--data)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((point, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text
              key={`xl-${point.row.position}`}
              x={point.cx}
              y={PAD_T + INNER_H + 24}
              textAnchor="middle"
              fontSize={FONT_TICK}
              fill="var(--ink-soft)"
            >
              {point.row.displayIndex}
            </text>
          ) : null,
        )}
        <text
          x={PAD_L + INNER_W / 2}
          y={H - 12}
          textAnchor="middle"
          fontSize={FONT_AXIS_TITLE}
          fill="var(--ink-soft)"
        >
          question number
        </text>

        {worstPoint ? (
          <g>
            <line
              x1={worstPoint.cx}
              x2={worstPoint.cx}
              y1={PAD_T}
              y2={PAD_T + INNER_H}
              stroke="var(--danger)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              opacity={0.5}
            />
            <circle cx={worstPoint.cx} cy={worstPoint.cy} r={5} fill="var(--danger)" />
            <text
              x={worstPoint.cx + (calloutFlips ? -12 : 12)}
              y={Math.max(worstPoint.cy - 14, PAD_T + 14)}
              textAnchor={calloutFlips ? 'end' : 'start'}
              fontSize={FONT_CALLOUT}
              fill="var(--danger)"
              fontWeight={600}
            >
              {formatPct(worstPoint.row.lead.dropPct)} leave at question{' '}
              {worstPoint.row.displayIndex}
            </text>
          </g>
        ) : null}

        {points.map((point) => (
          <circle
            key={`hit-${point.row.position}`}
            cx={point.cx}
            cy={point.cy}
            r={12}
            fill="transparent"
          >
            <title>
              {`Question ${point.row.displayIndex}: ${point.row.lead.label}\n${formatPeople(
                point.row.reached,
              )} people got here · ${formatPct(
                point.row.lead.dropPct,
              )} left without answering`}
            </title>
          </circle>
        ))}
      </svg>

      <p className="mt-2 text-xs text-ink-soft">
        Each point is a question, in order. The height is how many people were still going.
        Hover a point to see which question it is.
        {peak < SMALL_SAMPLE ? (
          <>
            {' '}
            Only {formatPeople(peak)} people so far, so single visitors move the line
            noticeably — treat the shape as indicative until traffic builds.
          </>
        ) : null}
      </p>
    </div>
  );
}
