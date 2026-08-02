import type { Metadata } from "next";
import { Link } from '@repo/i18n/navigation';
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('terms.metaTitle'),
    description: t('terms.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function TermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { termsData } = await getLegalDocuments(locale);
  const { lastUpdated, sections } = termsData;

  return (
    <>
      <h1>{t('terms.title')}</h1>
      <p className="text-sm text-si-on-surface-variant">
        {t('terms.lastUpdated', { date: lastUpdated })}
      </p>

      {sections.map((s) => {
        // Inject cross-links into specific sections
        const isPrivacySection = s.id === "privacy";
        const isGoverningLaw = s.id === "governing-law";
        const isContactSection = s.id === "contact";
        const isAgreementSection = s.id === "agreement-and-acceptance";
        const hasPolicyList = isContactSection || isAgreementSection;

        return (
          <section key={s.id}>
            <h2>{s.title}</h2>
            {s.content.map((p, i) => {
              // Replace /privacy references with actual links
              if (isPrivacySection && p.includes("/privacy")) {
                const parts = p.split("/privacy");
                return (
                  <p key={i}>
                    {parts[0]}
                    <Link href="/privacy">/privacy</Link>
                    {parts[1]}
                  </p>
                );
              }

              // Add ODR link in governing law section
              if (
                isGoverningLaw &&
                p.includes("https://ec.europa.eu/consumers/odr")
              ) {
                const parts = p.split(
                  "https://ec.europa.eu/consumers/odr"
                );
                return (
                  <p key={i}>
                    {parts[0]}
                    <a
                      href="https://ec.europa.eu/consumers/odr"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      https://ec.europa.eu/consumers/odr
                    </a>
                    {parts[1]}
                  </p>
                );
              }

              // Add /privacy link in contact section
              if (isContactSection && p.includes("/privacy")) {
                const parts = p.split("/privacy");
                return (
                  <p key={i}>
                    {parts[0]}
                    <Link href="/privacy">/privacy</Link>
                    {parts[1]}
                  </p>
                );
              }

              return <p key={i}>{p}</p>;
            })}
            {s.list && (
              <ul>
                {s.list.map((item, i) => {
                  const relatedHrefs = ['/subscription', '/money-back', '/privacy', '/cookies'] as const;
                  if (hasPolicyList && i < relatedHrefs.length) {
                    return (
                      <li key={i}>
                        <Link href={relatedHrefs[i]} style={{ color: 'inherit' }}>
                          {item}
                        </Link>
                      </li>
                    );
                  }
                  return <li key={i}>{item}</li>;
                })}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
