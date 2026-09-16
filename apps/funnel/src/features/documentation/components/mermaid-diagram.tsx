'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronDown, Download, Expand, LoaderCircle, RotateCcw, Workflow, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

let renderer: Promise<typeof import('mermaid')['default']> | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();

function getRenderer() {
  if (!renderer) {
    renderer = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: 'Arial, sans-serif',
        themeVariables: {
          primaryColor: '#f5f5f5', primaryTextColor: '#171717', primaryBorderColor: '#a3a3a3',
          lineColor: '#737373', secondaryColor: '#ffffff', secondaryTextColor: '#171717', secondaryBorderColor: '#a3a3a3',
          tertiaryColor: '#fafafa', tertiaryTextColor: '#171717', tertiaryBorderColor: '#a3a3a3',
          clusterBkg: '#fafafa', clusterBorder: '#d4d4d4', edgeLabelBackground: '#ffffff',
          textColor: '#171717', mainBkg: '#f5f5f5', nodeBorder: '#a3a3a3',
          fontSize: '14px',
        },
        flowchart: { htmlLabels: false, curve: 'basis', padding: 18, nodeSpacing: 30, rankSpacing: 45 },
        suppressErrorRendering: true,
      });
      return mermaid;
    }).catch((error: unknown) => { renderer = undefined; throw error; });
  }
  return renderer;
}

function renderDiagram(id: string, code: string) {
  const task = renderQueue.catch(() => undefined).then(async () => {
    const mermaid = await getRenderer();
    await document.fonts.ready;
    return mermaid.render(id, code);
  });
  renderQueue = task;
  return task;
}

export function MermaidDiagram({ code, id }: { code: string; id: string }) {
  const uniqueId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let mounted = true;
    renderDiagram(`sg-${uniqueId}-${retry}`, code).then((result) => {
      if (mounted) setSvg(result.svg);
    }).catch(() => {
      if (mounted) setError(true);
    });
    return () => { mounted = false; };
  }, [code, uniqueId, retry]);

  function download() {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${id}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const canvas = svg ? <div className="docs-diagram-svg" style={{ width: `${zoom * 100}%`, minWidth: zoom > 1 ? `${zoom * 620}px` : undefined }} dangerouslySetInnerHTML={{ __html: svg }} /> : error ? (
    <div className="flex min-h-60 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><p>Nepavyko atvaizduoti diagramos.</p><Button variant="outline" onClick={() => { setError(false); setRetry((value) => value + 1); }}><RotateCcw />Bandyti dar kartą</Button></div>
  ) : <div className="flex min-h-60 flex-col items-center justify-center gap-3 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-5 animate-spin" /><p>Kraunama diagrama…</p></div>;

  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <figure className="docs-diagram" id={id} data-diagram-status={svg ? 'ready' : error ? 'error' : 'loading'}>
        <figcaption className="sr-only">Srauto diagrama</figcaption>
        <Card className="gap-0 py-0">
          <div className="docs-diagram-toolbar flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
            <span className="flex items-center gap-2 text-xs font-medium"><Workflow className="size-4" />Srauto diagrama</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon-sm" title="Sumažinti" aria-label="Sumažinti diagramą" onClick={() => setZoom((value) => Math.max(1, value - 0.5))} disabled={zoom <= 1 || !svg}><ZoomOut /></Button>
              <Button variant="ghost" size="icon-sm" title="Padidinti" aria-label="Padidinti diagramą" onClick={() => setZoom((value) => Math.min(4, value + 0.5))} disabled={zoom >= 4 || !svg}><ZoomIn /></Button>
              <DialogTrigger render={<Button variant="ghost" size="icon-sm" />} title="Atverti plačiai" aria-label="Atverti diagramą plačiai" disabled={!svg}><Expand /></DialogTrigger>
              <Button variant="ghost" size="icon-sm" title="Atsisiųsti SVG" aria-label="Atsisiųsti diagramą SVG formatu" onClick={download} disabled={!svg}><Download /></Button>
            </div>
          </div>
          {!expanded ? <div className="docs-diagram-viewport">{canvas}</div> : <div className="grid min-h-44 place-items-center text-sm text-muted-foreground">Diagrama atverta plačiame lange.</div>}
          <Collapsible className="docs-diagram-source group/source border-t px-3 py-2">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="w-full justify-between font-normal text-muted-foreground">Diagramos šaltinis<ChevronDown className="transition-transform group-data-open/source:rotate-180" /></CollapsibleTrigger>
            <CollapsibleContent><pre><code>{code}</code></pre></CollapsibleContent>
          </Collapsible>
        </Card>
      </figure>
      <DialogContent className="docs-diagram-dialog max-h-[92dvh] max-w-[94vw] gap-0 overflow-hidden p-0 sm:max-w-[min(1400px,94vw)]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b px-4 py-3">
          <div><DialogTitle>Srauto diagrama</DialogTitle><DialogDescription className="sr-only">Išplėsta diagrama su mastelio valdikliais.</DialogDescription></div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Sumažinti diagramą" onClick={() => setZoom((value) => Math.max(1, value - 0.5))} disabled={zoom <= 1}><ZoomOut /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="Padidinti diagramą" onClick={() => setZoom((value) => Math.min(4, value + 0.5))} disabled={zoom >= 4}><ZoomIn /></Button>
            <DialogClose render={<Button variant="ghost" size="icon-sm" />} aria-label="Uždaryti diagramą"><X /></DialogClose>
          </div>
        </DialogHeader>
        {expanded ? <div className="docs-diagram-expanded-viewport">{canvas}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
