'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, ClipboardList, ExternalLink, HeartPulse, Headphones, LogOut, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AdminCapability, AdminRole } from '@repo/admin-core/access';

const NAV_ITEMS = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: BarChart3, capability: 'analytics:view' as const, module: 'dashboard' as const },
  { href: '/admin/support', label: 'Support', icon: Headphones, capability: 'support:view' as const, module: 'support' as const },
  { href: '/admin/audit', label: 'Audit', icon: ClipboardList, capability: 'admin:manage' as const, module: 'audit' as const },
  { href: '/admin/health', label: 'Health', icon: HeartPulse, capability: 'admin:manage' as const, module: 'health' as const },
];

export interface AdminShellProps {
  children: ReactNode;
  projectLabel: string;
  adminHomePath: string;
  appPath: string;
  userEmail: string;
  role: AdminRole;
  capabilities: readonly AdminCapability[];
  modules: { dashboard: boolean; support: boolean; audit: boolean; health: boolean };
}

export function AdminShell({
  children,
  projectLabel,
  adminHomePath,
  appPath,
  userEmail,
  role,
  capabilities,
  modules,
}: AdminShellProps) {
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/');
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-30 border-b border-neutral-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
          <Link
            href={adminHomePath}
            className="flex shrink-0 items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-neutral-900 text-white shadow-sm">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold leading-tight text-neutral-950">
                Admin workspace
              </span>
              <span className="block max-w-44 truncate text-[11px] leading-tight text-neutral-500">
                {projectLabel}
              </span>
            </span>
          </Link>

          <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Admin navigation">
            {NAV_ITEMS.filter(
              (item) => modules[item.module] && capabilities.includes(item.capability),
            ).map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'inline-flex shrink-0 items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700'
                      : 'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-950'
                  }
                >
                  <Icon size={15} aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <span className="hidden max-w-56 truncate px-2 text-xs text-neutral-500 lg:block">
              {userEmail} · {role}
            </span>
            <Link
              href={appPath}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              Open app
              <ExternalLink size={13} aria-hidden="true" />
            </Link>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
            >
              <LogOut size={13} aria-hidden="true" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
