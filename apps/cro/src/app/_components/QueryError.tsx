import { NotAnAnalystError } from '@/lib/queries';

/**
 * Distinguishes "you are not on the analyst list" from a real failure.
 *
 * Reachable in one narrow case now that cro_analysts is the only gate: an
 * analyst removed from the table mid-session, whose page load lands between the
 * proxy's check and the query's. Without this it would look exactly like a
 * quiet week rather than like revoked access.
 */
export function QueryError({ error }: { error: unknown }) {
  const notAnalyst =
    error instanceof NotAnAnalystError ||
    (error instanceof Error && error.name === 'NotAnAnalystError');

  if (notAnalyst) {
    return (
      <div className="card border-l-2 px-4 py-4" style={{ borderLeftColor: 'var(--danger)' }}>
        <h2 className="text-sm font-semibold text-ink">You do not have access yet</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Your sign-in worked, but your account has not been given permission to read the
          quiz data, so there is nothing to show. Ask whoever manages the dashboard to add
          you.
        </p>
      </div>
    );
  }

  return (
    <div className="card border-l-2 px-4 py-4" style={{ borderLeftColor: 'var(--danger)' }}>
      <h2 className="text-sm font-semibold text-ink">This did not load</h2>
      <p className="mt-2 text-sm text-ink-soft">
        Something went wrong fetching the numbers. Try again in a moment.
      </p>
      {error instanceof Error ? (
        <p className="mt-3 text-xs text-ink-faint">{error.message}</p>
      ) : null}
    </div>
  );
}
