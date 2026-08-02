import type { Metadata } from "next";
import { Link } from '@repo/i18n/navigation';
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('contact.metaTitle'),
    description: t('contact.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function ContactPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { contactData } = await getLegalDocuments(locale);
  const { companyName, address, email, privacyEmail, supervisoryAuthority } =
    contactData;

  return (
    <>
      <h1>{t('contact.title')}</h1>

      <section>
        <h2>{t('contact.companyInfo')}</h2>
        <p>
          <strong>{companyName}</strong>
          <br />
          {address}
        </p>
      </section>

      <section>
        <h2>{t('contact.generalInquiries')}</h2>
        <p>
          {t('contact.emailLabel', { email: '' })}
          <a href={`mailto:${email}`}>{email}</a>
        </p>
      </section>

      <section>
        <h2>{t('contact.privacyRequests')}</h2>
        <p>
          {t('contact.privacyRequestsIntro')}
        </p>
        <p>
          <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>
        </p>
        <p>
          {t('contact.gdprResponse')}
        </p>
      </section>

      <section>
        <h2>{t('contact.supervisoryAuthority')}</h2>
        <p>
          {t('contact.supervisoryAuthorityIntro')}
        </p>
        <p>
          <strong>{supervisoryAuthority.name}</strong>
          <br />
          <a
            href={supervisoryAuthority.website}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('contact.findAuthority')}
          </a>
        </p>
      </section>

      <section>
        <h2>{t('contact.relatedPages')}</h2>
        <ul>
          <li>
            <Link href="/privacy">{t('privacy.title')}</Link>
          </li>
          <li>
            <Link href="/terms">{t('terms.title')}</Link>
          </li>
          <li>
            <Link href="/cookies">{t('cookies.title')}</Link>
          </li>
        </ul>
      </section>
    </>
  );
}
