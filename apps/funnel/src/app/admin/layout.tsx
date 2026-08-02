import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { createClient } from '@repo/shared/supabase/server';
import { isAdminEmail } from './_queries/_shared';
import '../globals.css';

// Server-rendered, no caching (D-17 — admin is always live).
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Defense-in-depth (D-03 post-verify): proxy.ts already gates /admin/*,
  // but if the proxy ever misroutes we redirect silently to /.
  // /admin/login is a child route; unauthenticated visitors fall through
  // so the login page can render its own UI.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If there IS a user but they're not allowlisted, hard-redirect to /.
  // (Unauthenticated falls through so /admin/login can render its own UI.)
  if (user && !isAdminEmail(user.email)) {
    redirect('/');
  }

  // /admin lives OUTSIDE [locale]; root layout (apps/funnel/src/app/layout.tsx)
  // is a passthrough returning children, so admin owns its own html+body.
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}
