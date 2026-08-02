import { useTranslations } from 'next-intl';

/**
 * Serwist's document fallback: served for ANY navigation that fails while the
 * device is offline (see the `fallbacks` block in src/sw.ts). It must be fully
 * self-contained — no data fetching, no images — because by definition the
 * network is gone when it renders. The colours are literals for the same
 * reason: it renders outside the member-area theme.
 */
export default function OfflinePage() {
  const t = useTranslations('pwa.offline');

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#131519] p-4 text-[#eceef1]">
      <div className="text-center">
        <h1 className="mb-4 text-2xl font-semibold">
          {t('title')}
        </h1>
        <p className="text-[#a8aeb8]">
          {t('message')}
        </p>
      </div>
    </div>
  );
}
