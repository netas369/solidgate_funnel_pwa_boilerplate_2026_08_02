import Link from 'next/link';
import { FilterBar } from '@/app/_components/FilterBar';
import { QueryError } from '@/app/_components/QueryError';
import { RetentionNote } from '@/app/_components/RetentionNote';
import {
  filterHref,
  parseFilters,
  rangeLabel,
  requiredQuizVersion,
  wasClamped,
  type DashboardSearchParams,
} from '@/lib/filters';
import { barWidthPct, formatPct, formatPeople } from '@/lib/presentation';
import {
  answerDistribution,
  funnelSegments,
  quizCatalog,
  resolveRange,
  type AnswerRow,
  type CatalogRow,
  type SegmentOptionRow,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * What people answer, question by question.
 *
 * ONE QUIZ VERSION, and the database enforces it rather than this page: answer
 * keys and the option vocabulary are per-version, so cro_answer_distribution
 * RAISES on a NULL p_quiz_variant instead of quietly blending two vocabularies
 * under one key name. No "All versions" chip here either.
 *
 * Nothing on this screen is a free-text answer. cro_answer_distribution runs an
 * allowlist of closed-vocabulary step types; everything else comes back as
 * value_kind 'freeform' with a NULL value, so the email gate still reports a
 * completion count and never an address.
 */
export default async function AnswersPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const quizVariant = requiredQuizVersion(filters);

  let catalog: CatalogRow[];
  let rows: AnswerRow[];
  let segmentOptions: SegmentOptionRow[];
  try {
    const range = resolveRange(filters);
    [catalog, rows, segmentOptions] = await Promise.all([
      quizCatalog(quizVariant),
      // Every question at once. One row per (step, key, value) across an
      // eight-step quiz is tens of rows, so fetching the whole distribution
      // costs less than a round trip per question — and it is what lets the
      // nav mark which questions have answers before you click them.
      answerDistribution(range, quizVariant, null, filters),
      funnelSegments(range),
    ]);
  } catch (error) {
    return <QueryError error={error} />;
  }

  // The catalog, not the answers, is the authoritative question list: a question
  // NOBODY answered is a finding, and building the nav from the distribution
  // would hide exactly that.
  const questions = catalog
    .filter((step) => step.is_question)
    .sort((a, b) => a.sort_index - b.sort_index);

  const answeredStepIds = new Set(rows.map((row) => row.step_id));
  const selected =
    (params.step && questions.some((q) => q.step_id === params.step) ? params.step : null) ??
    questions.find((q) => answeredStepIds.has(q.step_id))?.step_id ??
    questions[0]?.step_id ??
    null;

  const selectedStep = questions.find((q) => q.step_id === selected) ?? null;
  const selectedRows = rows.filter((row) => row.step_id === selected);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-xl font-semibold text-ink">What people answer</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Pick a question to see which answers people choose · {rangeLabel(filters)}
        </p>
      </header>

      <FilterBar filters={filters} basePath="/dashboard/answers" segments={segmentOptions} />
      <RetentionNote clamped={wasClamped(params.from)} filters={filters} />

      {questions.length === 0 ? (
        <p className="card p-8 text-sm text-ink-soft">
          No quiz definition is published for {quizVariant}, so there are no questions to
          break down. Run{' '}
          <code>npx tsx scripts/publish-quiz-definition.ts --apply</code>.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <nav className="card max-h-[34rem] overflow-y-auto" aria-label="Questions">
            {questions.map((question, index) => {
              const active = question.step_id === selected;
              const hasAnswers = answeredStepIds.has(question.step_id);
              return (
                <Link
                  key={question.step_id}
                  href={filterHref('/dashboard/answers', filters, { step: question.step_id })}
                  aria-current={active ? 'page' : undefined}
                  className="flex gap-3 border-b border-hairline px-4 py-3 text-sm last:border-0"
                  style={
                    active
                      ? { background: 'var(--paper-soft)', color: 'var(--ink)', fontWeight: 500 }
                      : { color: hasAnswers ? 'var(--ink-soft)' : 'var(--ink-faint)' }
                  }
                >
                  <span className="shrink-0 text-xs tabular-nums text-ink-soft">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1" title={question.step_id}>
                    {question.label ?? question.step_id}
                    {hasAnswers ? null : (
                      <span className="block text-[10px]">no answers in this period</span>
                    )}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="space-y-4">
            {selectedStep ? (
              <h3 className="text-base font-medium text-ink">
                {selectedStep.label ?? selectedStep.step_id}
              </h3>
            ) : null}

            {selectedRows.length === 0 ? (
              <p className="card p-8 text-sm text-ink-soft">
                Nobody answered this question in this period.
              </p>
            ) : (
              <AnswerGroups rows={selectedRows} />
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-ink-soft">
        The final answer only — someone who changed their mind is counted once, under what
        they ended up with. Free-text answers are never read: the email step reports how many
        people completed it and nothing else. Percentages are of the people who answered that
        question, so a multiple-choice question adds up to more than 100%.
      </p>
    </div>
  );
}

/**
 * One block per answer KEY.
 *
 * A step can declare several — a two-field form stores a name and a date under
 * one screen — and pooling their values into one list would rank "female"
 * against "1994" as though they were alternatives.
 */
function AnswerGroups({ rows }: { rows: AnswerRow[] }) {
  const keys = [...new Set(rows.map((row) => row.answer_key))];

  return (
    <>
      {keys.map((key) => {
        const group = rows.filter((row) => row.answer_key === key);
        const freeform = group.find((row) => row.value_kind === 'freeform');
        // Per KEY, not the sum of the value rows: choosing three options is
        // three rows but one person, so summing publishes percentages over 100.
        const answered = Math.max(...group.map((row) => row.answered_sessions));
        const max = Math.max(...group.map((row) => row.sessions));

        return (
          <section key={key} className="card overflow-hidden">
            {keys.length > 1 ? (
              <div className="border-b border-hairline px-4 py-2">
                <span className="label-eyebrow">{key}</span>
              </div>
            ) : null}

            {freeform ? (
              <p className="px-4 py-6 text-sm text-ink-soft">
                {formatPeople(freeform.sessions)} people answered this. The answers
                themselves are free text and are never published to this board.
              </p>
            ) : (
              <ul>
                {group.map((row) => (
                  <li
                    key={row.answer_value ?? key}
                    className="flex items-center gap-4 border-b border-hairline px-4 py-3 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm text-ink"
                        title={row.answer_value ?? undefined}
                      >
                        {/* The code is the fallback, never the hidden truth: a
                            variant published before option copy existed has no
                            label, and an empty row would be worse than "o1". */}
                        {row.answer_label ?? row.answer_value}
                      </span>
                      {row.in_option_set === false ? (
                        <span className="text-[10px] text-ink-faint">
                          no longer an option — answered before it was removed
                        </span>
                      ) : null}
                      <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full funnel-bar--track">
                        <div
                          className="funnel-bar"
                          style={{ width: `${barWidthPct(row.sessions, max)}%` }}
                        />
                      </div>
                    </div>
                    <div className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-ink">
                      {formatPeople(row.sessions)}
                    </div>
                    <div className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-soft">
                      {answered > 0 ? formatPct((row.sessions / answered) * 100) : '—'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
