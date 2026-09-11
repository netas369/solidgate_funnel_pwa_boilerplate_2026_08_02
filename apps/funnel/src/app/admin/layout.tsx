import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { AdminShell } from './_components/AdminShell';
import { getAuthenticatedAdminUser } from './_queries/admin-access';
import { adminLandingPathForEmail } from './_queries/_shared';
import { adminConfig } from '@/admin.config';
import '../globals.css';

// Server-rendered, no caching (D-17 — admin is always live).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin workspace',
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Defense-in-depth (D-03 post-verify): proxy.ts already gates /admin/*,
  // but if the proxy ever misroutes we redirect silently to /.
  // /admin/login is a child route; unauthenticated visitors fall through
  // so the login page can render its own UI.
  const user = await getAuthenticatedAdminUser();

  const projectLabel =
    process.env.ADMIN_PROJECT_LABEL?.trim() || adminConfig.project.defaultLabel;
  const configuredAppPath = process.env.ADMIN_APP_PATH?.trim();
  const appPath =
    configuredAppPath?.startsWith('/') && !configuredAppPath.startsWith('//')
      ? configuredAppPath
      : adminConfig.project.defaultAppPath;

  // /admin lives OUTSIDE [locale]; root layout (apps/funnel/src/app/layout.tsx)
  // is a passthrough returning children, so admin owns its own html+body.
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        {user ? (
          <AdminShell
            projectLabel={projectLabel}
            adminHomePath={adminLandingPathForEmail(user.email)}
            appPath={appPath}
            userEmail={user.email ?? 'Administrator'}
            role={user.adminAccess.role}
            capabilities={user.adminAccess.capabilities}
            modules={{
              dashboard: Object.entries(adminConfig.modules).some(
                ([key, enabled]) =>
                  key !== 'support' && key !== 'audit' && key !== 'health' && enabled,
              ),
              support: adminConfig.modules.support,
              audit: adminConfig.modules.audit,
              health: adminConfig.modules.health,
            }}
          >
            {children}
          </AdminShell>
        ) : (
          <div className="min-h-screen">{children}</div>
        )}
      </body>
    </html>
  );
}
