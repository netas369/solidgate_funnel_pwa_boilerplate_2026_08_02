'use client';

import { Menu } from '@base-ui/react/menu';
import { ChevronDown, LayoutDashboard } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LogoutButton } from './logout-button';

interface AuthAvatarProps {
  email: string;
  onDashboardClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

const menuItemClassName =
  'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-si-on-surface transition-colors outline-none hover:bg-si-surface-container focus-visible:bg-si-surface-container';

export function AuthAvatar({ email, onDashboardClick }: AuthAvatarProps) {
  const t = useTranslations('auth.accountMenu');

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={t('openLabel')}
        className="inline-flex items-center gap-2 rounded-full border border-si-outline-variant/30 bg-white/80 p-1 pr-3 text-sm font-medium text-si-on-surface shadow-sm transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-si-secondary focus-visible:ring-offset-2"
      >
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,rgba(236,240,255,0.95),rgba(255,255,255,0.95))] ring-1 ring-si-primary/15">
          <span className="bg-gradient-to-r from-si-primary to-si-on-primary-container bg-clip-text font-heading text-lg font-bold text-transparent">
            H
          </span>
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4 text-si-on-surface-variant" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner align="end" className="z-[100]" sideOffset={10}>
          <Menu.Popup className="min-w-64 rounded-2xl border border-si-outline-variant/20 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(23,32,74,0.45)] outline-none">
            <div className="rounded-xl bg-si-surface-container-low px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-si-on-surface-variant">
                {t('signedInAs')}
              </p>
              <p className="mt-1 break-all text-sm font-semibold text-si-on-surface">{email}</p>
            </div>

            <div className="mt-2 space-y-1">
              <Menu.LinkItem
                closeOnClick
                className={menuItemClassName}
                href="/dashboard"
                onClick={onDashboardClick}
              >
                <LayoutDashboard aria-hidden="true" className="h-4 w-4 text-si-primary" />
                <span>{t('dashboard')}</span>
              </Menu.LinkItem>

              <Menu.Separator className="my-2 h-px bg-si-outline-variant/20" />

              <LogoutButton className={menuItemClassName} />
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
