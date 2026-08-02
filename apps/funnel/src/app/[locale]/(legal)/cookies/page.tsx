import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getLegalDocuments } from "@/features/legal/config/legal-content";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'legal' });
  return {
    title: t('cookies.metaTitle'),
    description: t('cookies.metaDescription'),
    robots: { index: false, follow: false },
  };
}

export default async function CookiesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'legal' });
  const { cookiePolicyData } = await getLegalDocuments(locale);
  const { lastUpdated, cookies, sections } = cookiePolicyData;

  const essentialCookies = cookies.filter((c) => c.essential);
  const nonEssentialCookies = cookies.filter((c) => !c.essential);

  // Intro sections (introduction + "what are cookies") render before the cookie
  // tables; every later section renders after them, preserving document order.
  const tableSplitIndex = sections.findIndex((s) => s.id === "what-are-cookies");
  const sectionsBeforeTable =
    tableSplitIndex >= 0 ? sections.slice(0, tableSplitIndex + 1) : [];
  const sectionsAfterTable =
    tableSplitIndex >= 0 ? sections.slice(tableSplitIndex + 1) : sections;

  return (
    <>
      <h1>{t('cookies.title')}</h1>
      <p className="text-sm text-si-on-surface-variant">
        {t('cookies.lastUpdated', { date: lastUpdated })}
      </p>

      <p>
        {t('cookies.intro')}
      </p>

      {/* Intro sections (Introduction, What Are Cookies) from config */}
      {sectionsBeforeTable.map((s) => (
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

      {/* Cookie inventory */}
      <section>
        <h2>{t('cookies.cookiesWeUse')}</h2>

        <h3>{t('cookies.strictlyNecessary')}</h3>
        <p>
          {t('cookies.strictlyNecessaryDesc')}
        </p>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{t('cookies.tableHeaders.name')}</th>
                <th>{t('cookies.tableHeaders.provider')}</th>
                <th>{t('cookies.tableHeaders.purpose')}</th>
                <th>{t('cookies.tableHeaders.type')}</th>
                <th>{t('cookies.tableHeaders.essential')}</th>
                <th>{t('cookies.tableHeaders.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {essentialCookies.map((row) => (
                <tr key={row.name}>
                  <td>
                    <code>{row.name}</code>
                  </td>
                  <td>{row.provider}</td>
                  <td>{row.purpose}</td>
                  <td>{row.type}</td>
                  <td>{t('cookies.yes')}</td>
                  <td>{row.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>{t('cookies.analyticsFunctional')}</h3>
        <p>
          {t('cookies.analyticsFunctionalDesc')}
        </p>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>{t('cookies.tableHeaders.name')}</th>
                <th>{t('cookies.tableHeaders.provider')}</th>
                <th>{t('cookies.tableHeaders.purpose')}</th>
                <th>{t('cookies.tableHeaders.type')}</th>
                <th>{t('cookies.tableHeaders.essential')}</th>
                <th>{t('cookies.tableHeaders.duration')}</th>
              </tr>
            </thead>
            <tbody>
              {nonEssentialCookies.map((row) => (
                <tr key={row.name}>
                  <td>
                    <code>{row.name}</code>
                  </td>
                  <td>{row.provider}</td>
                  <td>{row.purpose}</td>
                  <td>{row.type}</td>
                  <td>{t('cookies.no')}</td>
                  <td>{row.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Remaining sections from config (types, examples, similar tech, why, managing, questions & contact) */}
      {sectionsAfterTable.map((s) => (
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

      {/* Changes to this policy */}
      <section>
        <h2>{t('cookies.changesToPolicy')}</h2>
        <p>
          {t('cookies.changesToPolicyContent')}
        </p>
      </section>
    </>
  );
}
