import type { Metadata } from "next";
import { Link } from '@repo/i18n/navigation';
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('subscription.metaTitle'),
    description: t('subscription.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function SubscriptionPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { subscriptionData } = await getLegalDocuments(locale);
  const { lastUpdated, sections } = subscriptionData;

  return (
    <>
      <h1>{t('subscription.title')}</h1>
      <p className="text-sm text-si-on-surface-variant">
        {t('subscription.lastUpdated', { date: lastUpdated })}
      </p>

      {sections.map((s) => (
        <section key={s.id}>
          <h2>{s.title}</h2>
          {s.content.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {s.list && (
            <ul>
              {s.list.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
          {s.postList?.map((p, i) => (
            <p key={`post-${i}`}>{p}</p>
          ))}
        </section>
      ))}

      <section>
        <h2>{t('subscription.relatedPolicies')}</h2>
        <ul>
          <li>
            <Link href="/terms">{t('subscription.termsLink')}</Link>
          </li>
          <li>
            <Link href="/privacy">{t('subscription.privacyLink')}</Link>
          </li>
          <li>
            <Link href="/contact">{t('subscription.contactLink')}</Link>
          </li>
        </ul>
      </section>
    </>
  );
}
