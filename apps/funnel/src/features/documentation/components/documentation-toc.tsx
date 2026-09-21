'use client';

import { useEffect, useState } from 'react';
import { ArrowUp, ChevronDown, List } from 'lucide-react';
import { cn } from '@repo/shared/utils';
import { documentationCopy as copy } from '@/app/documentation/config';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import type { DocumentationHeading } from './types';

export function DocumentationToc({ headings }: { headings: readonly DocumentationHeading[] }) {
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
        else visible.delete(entry.target.id);
      }
      const top = [...visible.entries()].sort((left, right) => left[1] - right[1])[0];
      if (top) setActiveId(top[0]);
    }, { rootMargin: '-90px 0px -55% 0px', threshold: 0 });
    for (const heading of headings) {
      const element = document.getElementById(heading.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <aside className="docs-toc sticky top-24 min-w-0 self-start border-l border-border pl-4 max-[1250px]:static max-[1250px]:order-first max-[1250px]:w-full max-[1250px]:rounded-lg max-[1250px]:border max-[1250px]:p-3">
      <Collapsible defaultOpen className="group/toc">
        <CollapsibleTrigger render={<Button variant="ghost" />} className="mb-2 h-auto w-full justify-start gap-2 px-2 py-2 text-xs font-medium"><List className="size-3.5" />{copy.onThisPage}<ChevronDown className="ml-auto size-3.5 transition-transform group-data-open/toc:rotate-180" /></CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-[calc(100svh-14rem)] max-[1250px]:[&_[data-slot=scroll-area-viewport]]:max-h-44">
            <nav aria-label={copy.onThisPage} className="flex flex-col gap-1 pr-3">
              {headings.map((heading) => (
                <Button
                  render={<a href={`#${heading.id}`} />}
                  nativeButton={false}
                  variant="ghost"
                  key={heading.id}
                  className={cn('h-auto min-h-8 justify-start px-2 py-1.5 text-left text-xs leading-5 font-normal whitespace-normal text-muted-foreground', heading.level > 2 && 'pl-5', activeId === heading.id && 'bg-muted font-medium text-foreground')}
                  aria-current={activeId === heading.id ? 'location' : undefined}
                >{heading.text}</Button>
              ))}
            </nav>
          </ScrollArea>
        </CollapsibleContent>
      </Collapsible>
      <Separator className="my-4 max-[1250px]:hidden" />
      <Button render={<a href="#documentation-main" />} nativeButton={false} variant="ghost" className="h-auto justify-start gap-2 px-2 py-1.5 text-xs font-normal text-muted-foreground max-[1250px]:hidden"><ArrowUp className="size-3.5" />Grįžti į viršų</Button>
    </aside>
  );
}
