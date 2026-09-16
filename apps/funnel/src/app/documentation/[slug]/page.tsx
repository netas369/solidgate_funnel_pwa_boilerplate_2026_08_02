import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, CalendarDays, FileText, History } from 'lucide-react';
import { documentationDocuments, documentationGroups, getDocumentation } from '@/features/documentation/content';
import { DocumentationToc } from '@/features/documentation/components/documentation-toc';
import { MermaidDiagram } from '@/features/documentation/components/mermaid-diagram';
import { documentationCopy as copy } from '../config';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export const dynamicParams = false;

export function generateStaticParams() {
  return documentationDocuments.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const document = getDocumentation(slug);
  return { title: document?.title ?? 'Dokumentas nerastas', description: document?.description };
}

export default async function DocumentationArticle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = getDocumentation(slug);
  if (!document) notFound();
  const group = documentationGroups.find((item) => item.id === document.group);
  const index = documentationDocuments.findIndex((item) => item.slug === slug);
  const previous = documentationDocuments[index - 1];
  const next = documentationDocuments[index + 1];

  return (
    <div className="docs-article-layout">
      <article className="docs-article">
        <header className="docs-article-header">
          <p className="docs-eyebrow">{group?.title}<Badge variant={document.status === 'current' ? 'secondary' : 'outline'}>{document.status === 'current' ? copy.current : copy.historical}</Badge></p>
          <h1>{document.title}</h1>
          <p className="docs-article-description">{document.description}</p>
          <div className="docs-article-meta"><span><CalendarDays size={14} />{document.updatedAt}</span><span><FileText size={14} />{document.headings.length} skyriai</span></div>
        </header>
        {document.status === 'historical' ? <Card className="mb-8 bg-muted/40"><CardContent className="flex items-start gap-3"><History className="mt-1 size-5 shrink-0 text-muted-foreground" /><div className="space-y-3"><p className="text-sm leading-6 text-muted-foreground">{copy.historicalNotice}</p><Button variant="link" nativeButton={false} render={<Link href="/documentation/audit-fixes" />} className="h-auto whitespace-normal p-0 text-left">{copy.historicalAction}<ArrowRight /></Button></div></CardContent></Card> : null}
        <div className="docs-prose" id="article-content">
          {document.blocks.map((block, blockIndex) => block.type === 'mermaid' ? <MermaidDiagram key={block.id} id={block.id} code={block.code} /> : <div key={`content-${blockIndex}`} dangerouslySetInnerHTML={{ __html: block.html }} />)}
        </div>
        <div className="docs-source-reference"><FileText size={14} /><span>{copy.sourceLabel}</span><code>{document.source}</code></div>
        <nav className="docs-pagination" aria-label="Ankstesnis ir kitas dokumentas">
          {previous ? <Link href={`/documentation/${previous.slug}`} className="group rounded-xl"><Card className="h-full transition-colors group-hover:ring-foreground/30"><CardContent className="space-y-3"><span className="flex items-center gap-2 text-xs text-muted-foreground"><ArrowLeft className="size-4" />Ankstesnis</span><strong className="block text-sm font-medium leading-6">{previous.title}</strong></CardContent></Card></Link> : <span />}
          {next ? <Link href={`/documentation/${next.slug}`} className="group rounded-xl text-right"><Card className="h-full transition-colors group-hover:ring-foreground/30"><CardContent className="space-y-3"><span className="flex items-center justify-end gap-2 text-xs text-muted-foreground">Kitas<ArrowRight className="size-4" /></span><strong className="block text-sm font-medium leading-6">{next.title}</strong></CardContent></Card></Link> : null}
        </nav>
        <footer className="docs-article-footer">{copy.footer}</footer>
      </article>
      <DocumentationToc headings={document.headings} />
    </div>
  );
}
