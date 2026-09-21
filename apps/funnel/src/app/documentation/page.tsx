import Link from 'next/link';
import { ArrowDown, ArrowRight, BookOpen, CircleCheck, CreditCard, Database, FileCheck2, GitBranch, History, RefreshCw, ShieldCheck, Waypoints } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { documentationDocuments, documentationGroups } from '@/features/documentation/content';
import { documentationCopy as copy } from './config';
import { setupNavigation } from '@/features/documentation/setup-navigation';

const groupIcons = { 'getting-started': BookOpen, 'payment-flows': Waypoints, 'data-model': Database, reliability: ShieldCheck, 'audit-history': History };
const lifecycleIcons = { checkout: CreditCard, verify: ShieldCheck, ledger: Database, renewal: RefreshCw };

export default function DocumentationPage() {
  return (
    <div className="docs-home mx-auto max-w-6xl space-y-10 px-5 py-10 sm:px-8 lg:px-12 lg:py-14">
      <section className="space-y-6">
        <Badge variant="outline">{copy.heroEyebrow}</Badge>
        <h1 className="max-w-3xl whitespace-pre-line text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{copy.heroTitle}</h1>
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">{copy.heroDescription}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" nativeButton={false} render={<Link href="/documentation/audit-fixes" />}>Naujausios pataisos <ArrowRight /></Button>
          <Button size="lg" variant="outline" nativeButton={false} render={<a href="#temos" />}>Naršyti temas <ArrowDown /></Button>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><BookOpen className="size-4" />{documentationDocuments.length} dokumentų</span>
          <span className="flex items-center gap-2"><GitBranch className="size-4" />Srautų diagramos</span>
          <span className="flex items-center gap-2"><CircleCheck className="size-4" />Atnaujinta {copy.date}</span>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Link href="/documentation/audit-fixes" className="group rounded-xl outline-offset-4">
          <Card className="h-full transition-colors group-hover:ring-foreground/30">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between gap-3"><FileCheck2 className="size-5" /><Badge variant="secondary">{copy.current}</Badge></div>
              <CardDescription>{copy.featuredLabel}</CardDescription>
              <CardTitle><h2>{copy.featuredTitle}</h2></CardTitle>
              <CardDescription className="leading-6">{copy.featuredDescription}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex items-center gap-2 text-sm font-medium">{copy.featuredAction}<ArrowRight className="size-4" /></CardContent>
          </Card>
        </Link>
        <Link href={setupNavigation.href} className="group rounded-xl outline-offset-4">
          <Card className="h-full transition-colors group-hover:ring-foreground/30">
            <CardHeader>
              <div className="mb-2 flex items-center justify-between gap-3"><BookOpen className="size-5" /><Badge variant="outline">01</Badge></div>
              <CardDescription>Promptai agentui</CardDescription>
              <CardTitle><h2>{setupNavigation.title}</h2></CardTitle>
              <CardDescription className="leading-6">{setupNavigation.description}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex items-center gap-2 text-sm font-medium">{setupNavigation.stepTitle}<ArrowRight className="size-4" /></CardContent>
          </Card>
        </Link>
      </div>

      <section className="space-y-5" aria-labelledby="lifecycle-title">
        <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Sistemos žemėlapis</p><h2 id="lifecycle-title" className="text-2xl font-semibold tracking-tight">{copy.lifecycleTitle}</h2><p className="text-sm leading-6 text-muted-foreground">{copy.lifecycleDescription}</p></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {copy.lifecycle.map((step) => {
            const Icon = lifecycleIcons[step.icon];
            return <Link href={`/documentation/${step.slug}`} key={step.number} className="group rounded-xl outline-offset-4"><Card className="h-full transition-colors group-hover:ring-foreground/30"><CardHeader><div className="mb-3 flex items-center justify-between"><Icon className="size-5" /><span className="font-mono text-xs text-muted-foreground">{step.number}</span></div><CardTitle><h3>{step.title}</h3></CardTitle><CardDescription className="leading-6">{step.description}</CardDescription></CardHeader><CardContent className="mt-auto"><Badge variant="secondary" className="max-w-full whitespace-normal break-all font-mono text-xs">{step.table}</Badge></CardContent></Card></Link>;
          })}
        </div>
      </section>

      <Separator />
      <section id="temos" className="space-y-5" aria-labelledby="topics-title">
        <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Dokumentacijos biblioteka</p><h2 id="topics-title" className="text-2xl font-semibold tracking-tight">{copy.sectionsTitle}</h2><p className="text-sm leading-6 text-muted-foreground">{copy.sectionsDescription}</p></div>
        <div className="grid gap-4 lg:grid-cols-2">
          {documentationGroups.map((group) => {
            const Icon = groupIcons[group.id as keyof typeof groupIcons] ?? BookOpen;
            const documents = documentationDocuments.filter((document) => document.group === group.id);
            return <Card key={group.id}><CardHeader><div className="mb-2 flex items-center justify-between"><Icon className="size-5" /><Badge variant="outline">{documents.length} dok.</Badge></div><CardTitle><h3>{group.title}</h3></CardTitle><CardDescription className="leading-6">{group.description}</CardDescription></CardHeader><CardContent><ul className="space-y-1">{documents.map((document) => <li key={document.slug}><Button variant="ghost" nativeButton={false} render={<Link href={`/documentation/${document.slug}`} />} className="h-auto min-h-10 w-full justify-between gap-3 whitespace-normal py-2 text-left font-normal"><span>{document.title}</span><ArrowRight className="size-4 shrink-0" /></Button></li>)}</ul></CardContent></Card>;
          })}
        </div>
      </section>

      <Card className="bg-muted/40"><CardHeader className="grid grid-cols-[auto_1fr] gap-x-4"><History className="mt-0.5 size-5" /><div className="space-y-2"><CardTitle><h2>{copy.historyTitle}</h2></CardTitle><CardDescription className="leading-6">{copy.historyDescription}</CardDescription></div></CardHeader></Card>
      <footer className="flex flex-col gap-3 border-t pt-6 text-xs leading-6 text-muted-foreground sm:flex-row sm:justify-between"><span className="shrink-0">Solidgate / Dokumentacija</span><p className="max-w-lg sm:text-right">{copy.footer}</p></footer>
    </div>
  );
}
