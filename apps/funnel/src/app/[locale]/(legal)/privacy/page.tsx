import type { Metadata } from "next";
import { Link } from '@repo/i18n/navigation';
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('privacy.metaTitle'),
    description: t('privacy.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { privacyPolicyData } = await getLegalDocuments(locale);
  const { lastUpdated, controllerIdentity, dataInventory, thirdParties, sections } =
    privacyPolicyData;

  return (
    <>
      <h1>{t('privacy.title')}</h1>
      <p className="text-sm text-si-on-surface-variant">
        {t('privacy.lastUpdated', { date: lastUpdated })}
      </p>

      {/* Controller identity */}
      <section>
        <h2>{sections[0].title}</h2>
        <p>
          <strong>{controllerIdentity.name}</strong> {t('privacy.controllerIntro')}
        </p>
        <p>
          {t('privacy.address', { address: controllerIdentity.address })}
          <br />
          {t('privacy.email', { email: '' })}
          <a href={`mailto:${controllerIdentity.email}`}>
            {controllerIdentity.email}
          </a>
        </p>
      </section>

      {/* Data inventory table */}
      <section>
        <h2>{sections[1].title}</h2>
        {sections[1].content.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{t('privacy.tableHeaders.category')}</th>
                <th>{t('privacy.tableHeaders.fields')}</th>
                <th>{t('privacy.tableHeaders.purpose')}</th>
                <th>{t('privacy.tableHeaders.legalBasis')}</th>
                <th>{t('privacy.tableHeaders.retention')}</th>
              </tr>
            </thead>
            <tbody>
              {dataInventory.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td>
                    <code>{row.fields}</code>
                  </td>
                  <td>{row.purpose}</td>
                  <td>{row.legalBasis}</td>
                  <td>{row.retention}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Sections 3-6 (purpose, legal basis, recipients, transfers) */}
      {sections.slice(2, 4).map((s) => (
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
        </section>
      ))}

      {/* Third-party processors table */}
      <section>
        <h2>{sections[4].title}</h2>
        {sections[4].content.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{t('privacy.tableHeaders.service')}</th>
                <th>{t('privacy.tableHeaders.role')}</th>
                <th>{t('privacy.tableHeaders.dataShared')}</th>
                <th>{t('privacy.tableHeaders.location')}</th>
                <th>{t('privacy.tableHeaders.transferMechanism')}</th>
              </tr>
            </thead>
            <tbody>
              {thirdParties.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.role}</td>
                  <td>{row.dataShared}</td>
                  <td>{row.location}</td>
                  <td>{row.transferMechanism}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Sections 6-12 (transfers, retention, rights, exercising, authority, provision, automated) */}
      {sections.slice(5).map((s) => (
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
        </section>
      ))}

      {/* Cross-links */}
      <section>
        <h2>{t('privacy.relatedPolicies')}</h2>
        <ul>
          <li>
            <Link href="/cookies">{t('privacy.cookiePolicyLink')}</Link>
          </li>
          <li>
            <Link href="/terms">{t('privacy.termsLink')}</Link>
          </li>
          <li>
            <Link href="/contact">{t('privacy.contactLink')}</Link>
          </li>
        </ul>
      </section>
    </>
  );
}
