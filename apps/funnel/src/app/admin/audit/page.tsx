import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { adminConfig } from '@/admin.config';
import { getAuthenticatedAdminUser } from '../_queries/admin-access';
import { recentAdminAudit } from '../_queries/audit';
import { humanizeSupportValue } from '@/features/admin/support/format';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Support audit · Admin',
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminAuditPage() {
  if (!adminConfig.modules.audit || !(await getAuthenticatedAdminUser('admin:manage'))) {
    redirect('/');
  }
  const audit = await recentAdminAudit();

  return (
    <main className="mx-auto max-w-[1200px] space-y-6 p-4 sm:p-6 lg:p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Governance</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-neutral-950">Support action audit</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Latest operator actions. Customer identity is represented only by a digest prefix.
        </p>
      </header>

      {audit.warning ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {audit.warning}
        </p>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[820px] w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Created (UTC)</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Customer digest</th>
                <th className="px-4 py-3">Completed</th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <td className="whitespace-nowrap px-4 py-3">{row.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  <td className="px-4 py-3 font-medium">{humanizeSupportValue(row.action)}</td>
                  <td className="px-4 py-3">{humanizeSupportValue(row.outcome)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-500">{row.actorUserId ?? 'deleted user'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-500">{row.customerDigestPrefix}…</td>
                  <td className="whitespace-nowrap px-4 py-3 text-neutral-500">
                    {row.completedAt ? row.completedAt.slice(0, 19).replace('T', ' ') : 'In progress'}
                  </td>
                </tr>
              ))}
              {audit.rows.length === 0 ? (
                <tr><td className="px-4 py-6 text-neutral-500" colSpan={6}>No support actions have been recorded.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
