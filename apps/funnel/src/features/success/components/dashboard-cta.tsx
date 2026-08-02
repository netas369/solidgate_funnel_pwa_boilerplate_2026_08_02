'use client';

import { useState } from 'react';
import { useRouter } from '@repo/i18n/navigation';
import { ChevronRight, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useQuizStore } from '@/stores/quiz-store';

export function DashboardCta() {
  const router = useRouter();
  const t = useTranslations('success');
  const [isNavigating, setIsNavigating] = useState(false);

  return (
    <div>
      {/* CTA with glow */}
      <div className="relative">
        <div className="absolute inset-0 rounded-2xl bg-si-secondary-container/30 blur-xl" />
        <button
          type="button"
          disabled={isNavigating}
          onClick={() => {
            setIsNavigating(true);
            useQuizStore.getState().reset();
            router.replace('/dashboard');
          }}
          className="group relative flex min-h-[56px] w-full cursor-pointer items-center justify-center gap-2 rounded-2xl py-5 text-lg font-bold text-white shadow-[0_20px_40px_rgba(6,20,73,0.15)] signature-gradient transition-all hover:scale-[1.02] active:scale-[0.98] disabled:cursor-wait disabled:opacity-80"
        >
          {isNavigating ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('dashboard.redirecting')}
            </>
          ) : (
            <>
              {t('dashboard.buttonText')}
              <ChevronRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />
            </>
          )}
        </button>
      </div>

      {/* Trust micro-row */}
      <div className="mt-4 flex items-center justify-center gap-4 text-xs text-si-on-surface-variant">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('dashboard.ssl')}
        </span>
        <span className="h-3 w-px bg-si-outline-variant/30" />
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          {t('dashboard.instantAccess')}
        </span>
      </div>
    </div>
  );
}
