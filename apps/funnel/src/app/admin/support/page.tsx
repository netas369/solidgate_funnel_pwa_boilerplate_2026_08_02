import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthenticatedAdminUser } from '../_queries/admin-access';
import { SupportConsole } from './_components/SupportConsole';
import { adminConfig } from '@/admin.config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Customer support · Admin',
  robots: { index: false, follow: false },
};

export default async function AdminSupportPage() {
  const principal = await getAuthenticatedAdminUser('support:view');
  if (!principal || !adminConfig.modules.support) redirect('/');

  return (
    <main className="mx-auto max-w-[1440px] p-4 sm:p-6 lg:p-8">
      <SupportConsole
        allowedActions={
          principal.adminAccess.capabilities.includes('support:act')
            ? adminConfig.support.enabledActions
            : []
        }
      />
    </main>
  );
}
