import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthenticatedAdminUser } from '../_queries/admin-access';
import { getAdminHealthChecks, type AdminHealthStatus } from '@/features/admin/health';
import { adminConfig } from '@/admin.config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'System health · Admin',
  robots: { index: false, follow: false, nocache: true },
};

const STATUS_STYLES: Record<AdminHealthStatus, string> = {
  healthy: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
};

export default async function AdminHealthPage() {
  if (!adminConfig.modules.health || !(await getAuthenticatedAdminUser('admin:manage'))) {
    redirect('/');
  }
  const checks = await getAdminHealthChecks();
  const failed = checks.filter((check) => check.status === 'failed').length;

  return (
    <main className="mx-auto max-w-[1100px] space-y-6 p-4 sm:p-6 lg:p-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Operations</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-neutral-950">System health</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Configuration and schema compatibility checks. No customer data is displayed.
        </p>
      </header>

      <div className={`rounded-xl border px-4 py-3 text-sm ${failed > 0 ? STATUS_STYLES.failed : STATUS_STYLES.healthy}`} role="status">
        {failed > 0
          ? `${failed} required check${failed === 1 ? '' : 's'} failed.`
          : 'All required admin checks passed.'}
      </div>

      <section className="grid gap-4 md:grid-cols-2">
        {checks.map((check) => (
          <article key={check.id} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-neutral-900">{check.label}</h2>
              <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${STATUS_STYLES[check.status]}`}>
                {check.status}
              </span>
            </div>
            <p className="mt-3 text-sm text-neutral-600">{check.detail}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
