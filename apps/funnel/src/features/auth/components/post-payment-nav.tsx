'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter, usePathname } from '@repo/i18n/navigation';
import { createClient } from '@repo/shared/supabase/client';
import { BOILERPLATE_BRAND } from '@repo/shared/boilerplate-brand';
import { AuthAvatar } from './auth-avatar';

interface PostPaymentNavProps {
  initialEmail?: string | null;
  hideAvatar?: boolean;
}

export function PostPaymentNav({ initialEmail = null, hideAvatar = false }: PostPaymentNavProps = {}) {
  const t = useTranslations('auth.accountMenu');
  const [email, setEmail] = useState<string | null>(initialEmail);
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const isOnSuccess = pathname === '/success';

  const handleDashboardClick = isOnSuccess
    ? (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        router.replace('/dashboard');
      }
    : undefined;

  useEffect(() => {
    setMounted(true);
    const supabase = createClient();
    let cancelled = false;

    // Only probe getUser if we didn't already have an initial email (reduces
    // auth-lock contention when multiple components/effects fire under strict mode).
    if (!initialEmail) {
      supabase.auth
        .getUser()
        .then(({ data: { user } }) => {
          if (!cancelled) setEmail(user?.email ?? null);
        })
        .catch(() => {
          // Swallow navigator-lock timeouts in dev/strict mode; auth state change will recover.
        });
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [initialEmail]);

  return (
    <nav className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-si-outline-variant/20 bg-white/70 px-4 backdrop-blur-md lg:px-6">
      <Link className="font-heading text-lg font-bold" href="/dashboard">
        <span className="bg-gradient-to-r from-si-primary to-si-on-primary-container bg-clip-text text-transparent">
          {BOILERPLATE_BRAND.shortName}
        </span>{' '}
        <span className="text-si-on-surface">{t('access')}</span>
      </Link>

      {!hideAvatar && mounted && email ? (
        <AuthAvatar email={email} onDashboardClick={handleDashboardClick} />
      ) : null}
    </nav>
  );
}
