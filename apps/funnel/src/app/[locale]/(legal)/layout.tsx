import { getTranslations, setRequestLocale } from 'next-intl/server';
import { BackLink } from './back-link';

/**
 * Shared frame for /privacy, /terms, /subscription, /money-back, /cookies and
 * /contact. Every string comes from the `legal` message namespace via
 * `getLegalDocuments()` — these routes are renderers, nothing more.
 */

/**
 * DELETE THIS BANNER once you have replaced the placeholder legal content.
 *
 * It is rendered deliberately: shipping a real product with a fictitious
 * company name and refund policy is a legal liability, and a comment in a
 * source file is far too easy to miss.
 */
function PlaceholderLegalBanner() {
  return (
    <aside
      role="note"
      className="mb-8 rounded-lg border-2 border-dashed border-amber-500 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <p className="font-bold">TODO(new product): placeholder legal content</p>
      <p className="mt-1">
        The company name, registered address, contact addresses, refund window and
        third-party processor list on this page are boilerplate placeholders. Replace
        them in <code>packages/i18n/messages/en/legal.json</code>, have the result
        reviewed by a qualified lawyer for your jurisdiction, then delete this banner
        from <code>app/[locale]/(legal)/layout.tsx</code>. This is not legal advice.
      </p>
    </aside>
  );
}

export default async function LegalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });

  return (
    <div className="min-h-screen bg-si-surface">
      <main className="mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <BackLink label={t('meta.back')} />
        <PlaceholderLegalBanner />
        <article className="legal-prose max-w-none text-sm sm:text-base text-si-on-surface">
          {children}
        </article>
      </main>
    </div>
  );
}
