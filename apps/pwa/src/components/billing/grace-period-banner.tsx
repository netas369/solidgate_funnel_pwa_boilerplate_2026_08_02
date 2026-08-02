// Sticky, non-dismissible top banner shown across the authenticated PWA shell
// when the user has a past_due+grace subscription. Server component — no
// client JS — so it cannot be hidden by user action.
//
// Style: amber→orange gradient to read as a warning without feeling like a
// hard error. Z-index 100 + fixed positioning keeps it above existing UI;
// the layout wraps children in pt-20 so content isn't covered.

import { Link } from '@repo/i18n/navigation';
import { getTranslations } from 'next-intl/server';

interface Props {
  expiresAt: string | null;
  productName: string;
  locale: string;
}

export async function GracePeriodBanner({ expiresAt, locale }: Props) {
  const t = await getTranslations({ locale, namespace: 'billing.grace' });

  // Format date in the user's locale; fall back to a generic "soon" label
  // when expires_at is null (rare — grace rows usually have a TTL set).
  const formattedDate = expiresAt
    ? new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(new Date(expiresAt))
    : t('expiresSoon');

  return (
    <div
      role="alert"
      className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-amber-500 to-orange-500 text-white px-4 py-3 shadow-md"
    >
      <div className="max-w-5xl mx-auto flex items-center gap-3 flex-wrap">
        <WarningIcon />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">{t('bannerTitle')}</p>
          <p className="text-xs opacity-90">
            {t('bannerMessage', { date: formattedDate })}
          </p>
        </div>
        <Link
          href="/billing/update-payment"
          locale={locale as 'en'}
          className="bg-white text-amber-700 font-semibold px-4 py-2 rounded text-sm hover:bg-amber-50 shrink-0"
        >
          {t('bannerCta')}
        </Link>
      </div>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg
      aria-hidden="true"
      className="w-6 h-6 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
