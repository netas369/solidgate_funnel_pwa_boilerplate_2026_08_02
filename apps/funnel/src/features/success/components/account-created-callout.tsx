'use client';

import { CheckCircle, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  email: string;
}

export function AccountCreatedCallout({ email }: Props) {
  const t = useTranslations('success');

  return (
    <section className="overflow-hidden rounded-xl border border-si-outline-variant/10 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-l-4 border-si-secondary p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-si-secondary-container/20">
          <Mail className="h-5 w-5 text-si-secondary" aria-hidden="true" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-si-primary">{t('account.heading')}</h2>
            <CheckCircle className="h-4 w-4 text-si-secondary" />
          </div>
          <p className="mt-1 text-sm text-si-on-surface-variant">
            {t('account.description', { email })}
          </p>
        </div>
      </div>
    </section>
  );
}
