'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight, BookOpen, FileText, Hash, House, Search, X } from 'lucide-react';
import { documentationCopy as copy } from '@/app/documentation/config';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { DocumentationGroup, DocumentationMetadata } from './types';
import { setupNavigation, setupSearchDocuments, setupStepsNavigation } from '../setup-navigation';

interface ShellProps {
  documents: readonly DocumentationMetadata[];
  groups: readonly DocumentationGroup[];
  children: React.ReactNode;
}

function DocumentationSidebar({ documents, groups, pathname }: Omit<ShellProps, 'children'> & { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  const isSetup = pathname === setupNavigation.href || pathname.startsWith(`${setupNavigation.href}/`);
  const closeNavigation = () => setOpenMobile(false);

  return (
    <Sidebar className="docs-sidebar" collapsible="offcanvas">
      <SidebarHeader className="gap-5 p-5">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link href="/documentation" />}
              size="lg"
              className="h-auto gap-3 p-0 hover:bg-transparent"
              onClick={closeNavigation}
              aria-label="Solidgate dokumentacijos pradžia"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><BookOpen className="size-5" strokeWidth={1.7} /></span>
              <span className="grid gap-1"><span className="text-base font-semibold tracking-tight">{copy.name}</span><span className="text-xs font-normal text-muted-foreground">{copy.subtitle}</span></span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <Tabs value={isSetup ? 'setup' : 'documentation'}>
          <TabsList className="w-full" aria-label="Dokumentacijos ir instrukcijų pasirinkimas">
            <TabsTrigger value="documentation" nativeButton={false} render={<Link href="/documentation" />} onClick={closeNavigation} className="flex-1 px-2 text-xs">Dokumentacija</TabsTrigger>
            <TabsTrigger value="setup" nativeButton={false} render={<Link href={setupNavigation.href} />} onClick={closeNavigation} className="flex-1 px-2 text-xs">{setupNavigation.shortTitle}</TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <Separator />
      <SidebarContent className="gap-4 px-3 py-4">
        <nav aria-label={copy.navigation} className="space-y-4">
          {isSetup ? (
            <SidebarGroup className="p-0">
              <SidebarGroupLabel className="h-auto px-2 pb-3 text-xs">{setupNavigation.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {setupStepsNavigation.map((step) => {
                    const active = pathname === step.href;
                    const searchDocument = setupSearchDocuments.find((document) => document.slug === step.slug);
                    return (
                      <SidebarMenuItem key={step.id}>
                        <SidebarMenuButton render={<Link href={step.href} />} onClick={closeNavigation} isActive={active} aria-current={active ? 'page' : undefined} className="h-auto min-h-9 py-2"><span className="whitespace-normal! leading-5">{step.id}. {step.title}</span></SidebarMenuButton>
                        {active ? <SidebarMenu className="mt-1">
                          {searchDocument?.headings.map((heading) => (
                            <SidebarMenuItem key={heading.id}>
                              <SidebarMenuButton render={<Link href={`${step.href}#${heading.id}`} />} onClick={closeNavigation} className="h-auto min-h-9 py-2 pl-5 text-muted-foreground"><span className="whitespace-normal! leading-5">{heading.text}</span></SidebarMenuButton>
                            </SidebarMenuItem>
                          ))}
                        </SidebarMenu> : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ) : (
            <>
              <SidebarGroup className="p-0">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton render={<Link href="/documentation" />} onClick={closeNavigation} isActive={pathname === '/documentation'} aria-current={pathname === '/documentation' ? 'page' : undefined} className="min-h-9"><House /><span>{copy.overview}</span></SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
              {groups.map((group) => (
                <SidebarGroup key={group.id} className="p-0">
                  <SidebarGroupLabel className="h-auto px-2 pb-2 text-xs">{group.title}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {documents.filter((document) => document.group === group.id).map((document) => {
                        const href = `/documentation/${document.slug}`;
                        const active = pathname === href;
                        return (
                          <SidebarMenuItem key={document.slug}>
                            <SidebarMenuButton render={<Link href={href} />} onClick={closeNavigation} isActive={active} aria-current={active ? 'page' : undefined} title={document.title} className="h-auto min-h-9 items-start py-2 text-[13px]">
                              <span className="min-w-0 flex-1 whitespace-normal! leading-5">{document.title}</span>
                              {document.status === 'current' ? <Badge variant="outline" className="mt-0.5 shrink-0 px-1.5 text-[10px]">{copy.current}</Badge> : null}
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </>
          )}
        </nav>
      </SidebarContent>
      <Separator />
      <SidebarFooter className="flex-row items-center justify-between p-5 text-xs text-muted-foreground"><span>Dokumentų versija</span><span className="font-mono">{copy.date}</span></SidebarFooter>
    </Sidebar>
  );
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function DocumentationShell({ documents, groups, children }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const currentDocument = documents.find((document) => pathname === `/documentation/${document.slug}`);
  const currentGroup = groups.find((group) => group.id === currentDocument?.group);
  const isSetup = pathname === setupNavigation.href || pathname.startsWith(`${setupNavigation.href}/`);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const results = [...setupSearchDocuments, ...documents].flatMap((document) => {
    const documentText = normalize(`${document.title} ${document.description} ${document.source}`);
    const documentMatches = terms.every((term) => documentText.includes(term));
    const matches: { href: string; title: string; context: string; heading: boolean }[] = [];
    if (documentMatches) matches.push({ href: `/documentation/${document.slug}`, title: document.title, context: document.description, heading: false });
    if (terms.length > 0) {
      for (const heading of document.headings) {
        if (terms.every((term) => normalize(heading.text).includes(term))) {
          matches.push({ href: `/documentation/${document.slug}#${heading.id}`, title: heading.text, context: document.title, heading: true });
        }
      }
    }
    return matches;
  }).slice(0, 18);

  function selectSearchResult(href: string) {
    setSearchOpen(false);
    router.push(href);
  }

  return (
    <SidebarProvider className="docs-shell min-h-svh bg-background text-foreground" style={{ '--sidebar-width': '17rem' } as React.CSSProperties}>
      <Button render={<a href="#documentation-main" />} nativeButton={false} className="fixed -top-20 left-4 z-[100] focus:top-4">Pereiti į turinį</Button>
      <DocumentationSidebar documents={documents} groups={groups} pathname={pathname} />
      <div className="docs-workspace min-w-0 flex-1">
        <header className="docs-topbar sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <SidebarTrigger aria-label="Atverti arba užverti dokumentacijos meniu" className="-ml-1 shrink-0" />
          <Separator orientation="vertical" className="mr-1 h-4 self-auto" />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap gap-2 text-xs sm:text-sm">
              <BreadcrumbItem className="hidden sm:inline-flex"><BreadcrumbLink render={<Link href="/documentation" />}>Dokumentacija</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem className="min-w-0"><BreadcrumbPage className="truncate">{isSetup ? (setupStepsNavigation.find((step) => step.href === pathname)?.title ?? setupNavigation.shortTitle) : currentGroup?.title ?? 'Pradžia'}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Button variant="outline" onClick={() => setSearchOpen(true)} aria-label={copy.searchLabel} className="ml-auto size-9 shrink-0 px-0 sm:h-9 sm:w-64 sm:justify-start sm:gap-2 sm:px-3">
            <Search className="size-4 text-muted-foreground" /><span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{copy.search}</span><Kbd className="ml-auto hidden shrink-0 sm:inline-flex">⌘ K</Kbd>
          </Button>
        </header>
        <main id="documentation-main" tabIndex={-1}>{children}</main>
      </div>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
          <DialogHeader className="sr-only"><DialogTitle>{copy.searchLabel}</DialogTitle><DialogDescription>{copy.searchHint}. Rodyklėmis pasirink rezultatą, Enter atverk, Escape uždaryk.</DialogDescription></DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder={copy.search} aria-label={copy.searchLabel} className="pr-10" />
            <CommandList className="max-h-[min(60dvh,28rem)]">
              <CommandEmpty>{copy.searchEmpty}</CommandEmpty>
              {results.length > 0 ? (
                <CommandGroup heading={copy.searchHint}>
                  {results.map((result) => (
                    <CommandItem key={result.href} value={result.href} onSelect={() => selectSearchResult(result.href)} className="gap-3 py-3">
                      {result.heading ? <Hash className="size-4" /> : <FileText className="size-4" />}
                      <span className="min-w-0 flex-1"><span className="block whitespace-normal text-sm leading-5">{result.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{result.context}</span></span><ArrowUpRight className="ml-auto size-3.5" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </CommandList>
          </Command>
          <DialogClose render={<Button variant="ghost" size="icon-sm" className="absolute top-2.5 right-2.5" />} aria-label="Uždaryti paiešką"><X className="size-4" /></DialogClose>
          <Separator />
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground"><span>↑ ↓ pasirinkti · Enter atverti</span><span className="inline-flex items-center gap-2"><Kbd>Esc</Kbd> uždaryti</span></div>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
