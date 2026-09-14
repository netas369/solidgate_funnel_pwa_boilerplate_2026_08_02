import Link from 'next/link';
import { filterHref, type DashboardFilters } from '@/lib/filters';

/**
 * Shows or hides the branch screens, and the per-question timing detail.
 *
 * Links, not client-side toggles: the state belongs in the URL so it survives
 * the auto-refresh and can be shared. Both are folded away by default — the
 * screen is for finding where people leave, and the branches and the timings
 * are the second question, not the first.
 *
 * `armCount` must count BRANCHES only (the assembler's `armCount` does). The
 * screens everyone walks through are rendered either way, so counting them here
 * would offer to reveal rows already on the page.
 */
export function ViewToggles({
  showArms,
  showDetail,
  armCount,
  filters,
}: {
  showArms: boolean;
  showDetail: boolean;
  armCount: number;
  filters: DashboardFilters;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {armCount > 0 ? (
        <Toggle
          href={filterHref('/dashboard/steps', filters, {
            ...(showArms ? {} : { arms: '1' }),
            ...(showDetail ? { detail: '1' } : {}),
          })}
        >
          {showArms ? 'Hide branch screens' : `Show ${armCount} branch screens`}
        </Toggle>
      ) : null}
      <Toggle
        href={filterHref('/dashboard/steps', filters, {
          ...(showArms ? { arms: '1' } : {}),
          ...(showDetail ? {} : { detail: '1' }),
        })}
      >
        {showDetail ? 'Hide timing detail' : 'Show timing detail'}
      </Toggle>
    </div>
  );
}

function Toggle({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-xs font-medium text-ink-soft underline underline-offset-4">
      {children}
    </Link>
  );
}
