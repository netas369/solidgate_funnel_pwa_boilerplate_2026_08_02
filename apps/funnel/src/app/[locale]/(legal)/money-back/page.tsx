import type { Metadata } from "next";
import { Link } from '@repo/i18n/navigation';
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('moneyBack.metaTitle'),
    description: t('moneyBack.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function MoneyBackPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { moneyBackData } = await getLegalDocuments(locale);
  const { lastUpdated, sections } = moneyBackData;

  return (
    <>
      <h1>{t('moneyBack.title')}</h1>
      <p className="text-sm text-si-on-surface-variant">
        {t('moneyBack.lastUpdated', { date: lastUpdated })}
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
        <h2>{t('moneyBack.relatedPolicies')}</h2>
        <ul>
          <li>
            <Link href="/subscription">{t('moneyBack.subscriptionLink')}</Link>
          </li>
          <li>
            <Link href="/terms">{t('moneyBack.termsLink')}</Link>
          </li>
          <li>
            <Link href="/contact">{t('moneyBack.contactLink')}</Link>
          </li>
        </ul>
      </section>
    </>
  );
}
