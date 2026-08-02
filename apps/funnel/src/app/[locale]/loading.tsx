import { useTranslations } from 'next-intl';

export default function Loading() {
  const t = useTranslations('common.ui');

  return (
    <div
      className="min-h-[60vh] flex items-center justify-center bg-si-surface"
      aria-label={t('loadingContent')}
      role="status"
    >
      <div className="max-w-2xl w-full px-6">
        <div className="h-8 w-48 bg-si-outline-variant/40 rounded-lg animate-pulse" />
        <div className="mt-6 space-y-3">
          <div className="h-4 w-full bg-si-outline-variant/30 rounded animate-pulse" />
          <div className="h-4 w-5/6 bg-si-outline-variant/30 rounded animate-pulse" />
          <div className="h-4 w-4/6 bg-si-outline-variant/30 rounded animate-pulse" />
        </div>
        <div className="mt-8 h-48 w-full bg-si-outline-variant/20 rounded-xl animate-pulse" />
        <span className="sr-only">{t('loadingEllipsis')}</span>
      </div>
    </div>
  );
}
