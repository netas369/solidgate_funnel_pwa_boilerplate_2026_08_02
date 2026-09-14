import { FilterBar } from '@/app/_components/FilterBar';
import { QueryError } from '@/app/_components/QueryError';
import { RetentionNote } from '@/app/_components/RetentionNote';
import { parseFilters, rangeLabel, wasClamped, type DashboardSearchParams } from '@/lib/filters';
import { deviceLabel, languageName } from '@/lib/presentation';
import {
  funnelSegments,
  resolveRange,
  segmentBreakdown,
  type SegmentOptionRow,
  type SegmentRow,
} from '@/lib/queries';
import { SegmentTable } from './SegmentTable';

export const dynamic = 'force-dynamic';

/**
 * Who takes the quiz, and how far each group gets.
 *
 * BLENDING VERSIONS IS SAFE HERE, so this tab passes allowBlend. Every number
 * is a per-session count — how many, and the median position reached — never a
 * per-position curve, so nothing merges two versions' step numbering. "Is
 * Germany worse than France" is a fair question across a version bump; "what
 * happens at question 7" is not.
 */
export default async function SegmentsPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);

  let locales: SegmentRow[];
  let devices: SegmentRow[];
  let countries: SegmentRow[];
  let browsers: SegmentRow[];
  let sources: SegmentRow[];
  let segmentOptions: SegmentOptionRow[];
  try {
    const range = resolveRange(filters);
    [locales, devices, countries, browsers, sources, segmentOptions] = await Promise.all([
      segmentBreakdown(range, 'locale', filters),
      segmentBreakdown(range, 'device', filters),
      segmentBreakdown(range, 'country', filters),
      segmentBreakdown(range, 'browser', filters),
      segmentBreakdown(range, 'source', filters),
      funnelSegments(range),
    ]);
  } catch (error) {
    return <QueryError error={error} />;
  }

  const anyRows = [locales, devices, countries, browsers, sources].some((r) => r.length > 0);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-xl font-semibold text-ink">Language and device</h2>
        <p className="mt-1 text-sm text-ink-soft">
          How far people get, split by the language they took the quiz in and what they were
          using · {rangeLabel(filters)}
        </p>
      </header>

      <FilterBar
        filters={filters}
        basePath="/dashboard/segments"
        segments={segmentOptions}
        allowBlend
      />
      <RetentionNote clamped={wasClamped(params.from)} filters={filters} />

      {!anyRows ? (
        <p className="card p-8 text-sm text-ink-soft">
          Nobody has taken the quiz in this period yet.
        </p>
      ) : (
        <>
          <SegmentTable
            title="Language"
            hint="The language the session ENDED in — someone who switched counts once, under their last choice."
            rows={locales}
            label={(bucket) => (bucket === 'unknown' ? 'Unknown' : languageName(bucket))}
          />
          <SegmentTable
            title="Device"
            hint="Recorded once when the session was created, so it never changes mid-quiz."
            rows={devices}
            label={deviceLabel}
          />
          <SegmentTable
            title="Country"
            hint="From the request at session creation."
            rows={countries}
            label={(bucket) => (bucket === 'unknown' ? 'Unknown' : bucket.toUpperCase())}
          />
          <SegmentTable
            title="Browser"
            hint="Worth a look when one group stops much earlier than the rest — that is usually a rendering fault, not a copy problem."
            rows={browsers}
            label={(bucket) => (bucket === 'unknown' ? 'Unknown' : bucket)}
          />
          <SegmentTable
            title="Where they came from"
            hint="The traffic source recorded at session creation."
            rows={sources}
            label={(bucket) => (bucket === 'unknown' ? 'Direct or unknown' : bucket)}
          />

          <p className="text-xs text-ink-soft">
            A group that stops noticeably earlier than the others is getting stuck somewhere
            specific — compare it against the drop-off screen to find where. Language is the
            one dimension that can change during a session; the rest are stamped once at the
            start and are exact.
          </p>
        </>
      )}
    </div>
  );
}
