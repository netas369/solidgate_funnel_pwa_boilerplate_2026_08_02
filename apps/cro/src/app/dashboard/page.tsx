import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';

export const dynamic = 'force-dynamic';

/**
 * PLACEHOLDER — replaced by the real Overview in the next wave.
 *
 * It exists so the route tree builds and the shell (auth, layout, tabs, tokens)
 * can be verified end to end before any data call is wired. Deliberately makes
 * no query: a placeholder that half-queried would report failures belonging to
 * unfinished work rather than to the scaffold under test.
 */
export default function OverviewPlaceholder() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-ink">Quiz performance</h2>
      <p className="max-w-prose text-sm text-ink-soft">
        The board for {BOILERPLATE_BRAND.name}. The shell is in place — sign-in,
        the analyst gate, the tabs and the design tokens. The five tabs are wired
        up next.
      </p>
      <p className="card p-4 text-sm text-ink-soft">
        Nothing is queried on this screen yet.
      </p>
    </div>
  );
}
