import type { Metadata } from 'next';
import { DocumentationShell } from '@/features/documentation/components/documentation-shell';
import { documentationDocuments, documentationGroups } from '@/features/documentation/content';
import '../globals.css';
import './documentation.css';

export const metadata: Metadata = {
  title: { default: 'Solidgate dokumentacija', template: '%s | Solidgate dokumentacija' },
  description: 'Boilerplate mokėjimų sistemos dokumentacija: checkout, prenumeratos, duomenų modelis ir audito pataisos.',
  icons: { icon: '/images/favicon/favicon.ico' },
  robots: { index: false, follow: false },
};

export default function DocumentationLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="lt" data-scroll-behavior="smooth">
      <body className="documentation-body">
        <DocumentationShell documents={documentationDocuments} groups={documentationGroups}>
          {children}
        </DocumentationShell>
      </body>
    </html>
  );
}
