import { assembleFunnelResponse } from '@repo/shared/cro/funnel-response';
import { requiredQuizVersion, type DashboardFilters } from './filters';
import {
  funnelSegments,
  quizCatalog,
  resolveRange,
  stepFunnel,
  type CatalogRow,
  type SegmentOptionRow,
} from './queries';

export type FunnelView = ReturnType<typeof assembleFunnelResponse>;

/**
 * Everything a funnel-shaped tab needs, in one call.
 *
 * assembleFunnelResponse takes an envelope of quiz metadata that has to be
 * stitched together from two separate RPCs — the counts and the catalog. Doing
 * that inline on each page invites the pages to drift, and the pieces are
 * exactly the ones that fail QUIETLY: a missing `configHash` is how the
 * CATALOG_NOT_PUBLISHED warning fires, so a page that forgets to pass it shows
 * raw step ids and never explains why.
 *
 * The version is resolved through requiredQuizVersion(), so blending is
 * unreachable here by construction rather than by remembering.
 */
export async function loadFunnelView(filters: DashboardFilters): Promise<{
  view: FunnelView;
  segments: SegmentOptionRow[];
  quizVariant: string;
}> {
  const range = resolveRange(filters);
  const quizVariant = requiredQuizVersion(filters);

  const [rows, catalog, segments] = await Promise.all([
    stepFunnel(range, filters, quizVariant),
    quizCatalog(quizVariant),
    funnelSegments(range),
  ]);

  return {
    view: assembleFunnelResponse(rows, {
      ...catalogEnvelope(catalog, quizVariant),
      range,
      generatedAt: new Date().toISOString(),
    }),
    segments,
    quizVariant,
  };
}

/**
 * The quiz metadata, from however many catalog rows came back.
 *
 * ZERO ROWS IS THE INTERESTING CASE: the version has no published definition,
 * either because the publisher has not run or because sessions are arriving
 * under a variant nobody published. `configHash: null` is what makes the
 * assembler raise CATALOG_NOT_PUBLISHED, so this must not invent a value.
 */
function catalogEnvelope(catalog: CatalogRow[], quizVariant: string) {
  const head = catalog[0];
  return {
    quizVariant,
    configHash: head?.config_hash ?? null,
    firstStepId: head?.first_step_id ?? null,
    totalSteps: head?.total_steps ?? null,
    terminalStepIds: catalog.filter((row) => row.is_terminal).map((row) => row.step_id),
  };
}
