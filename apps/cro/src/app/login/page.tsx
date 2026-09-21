import { CroLoginForm } from './CroLoginForm';

export const dynamic = 'force-dynamic';

/**
 * Why someone bounced back here from a PMC Hub link.
 *
 * Without this the handoff fails silently into a bare sign-in form, and the
 * reasonable conclusion is "the link is broken" rather than "sign in, it will
 * work". Each case names the next action, and none of them says whether the
 * address is on the analyst list — that is not something a login screen should
 * confirm to whoever is holding the link.
 */
const SSO_NOTICE: Record<string, string> = {
  expired:
    'That link has already been used or has expired. Sign in below — it takes a moment and works the same way.',
  denied:
    'That link is no longer valid for this account. Sign in below, and ask whoever manages the dashboard if it keeps happening.',
  missing: 'That link was incomplete. Sign in below.',
  invalid: 'That link was not valid. Sign in below.',
};

export default async function CroLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso?: string }>;
}) {
  const { sso } = await searchParams;
  const notice = sso ? SSO_NOTICE[sso] : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6">
      {notice ? (
        <p
          role="status"
          className="card mb-4 w-full border-l-2 px-4 py-3 text-sm text-ink-soft"
          style={{ borderLeftColor: 'var(--ink-faint)' }}
        >
          {notice}
        </p>
      ) : null}
      <CroLoginForm />
    </main>
  );
}
