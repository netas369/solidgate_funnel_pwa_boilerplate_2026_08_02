import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@repo/shared/supabase/server';
import { isCroAnalyst } from '@/lib/cro-auth';
import { BrandMark } from '../_components/BrandMark';
import { DashboardTabs } from './DashboardTabs';

// Always live. A cached CRO board is worse than no board: the point is watching
// a change land.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Defence in depth: proxy.ts already gates every path here. This catches the
  // case where the proxy is misconfigured or bypassed.
  const supabase = await createClient();
  if (!(await isCroAnalyst(supabase))) redirect('/login');

  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <BrandMark />
          <DashboardTabs />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
