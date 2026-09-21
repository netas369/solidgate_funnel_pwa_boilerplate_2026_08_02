import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function DocumentationNotFound() {
  return <div className="mx-auto max-w-2xl px-5 py-20"><Card><CardHeader className="space-y-3"><FileQuestion className="size-8 text-muted-foreground" /><CardDescription>404 / DOKUMENTACIJA</CardDescription><CardTitle><h1 className="text-3xl tracking-tight">Dokumentas nerastas</h1></CardTitle><CardDescription className="leading-6">Ši nuoroda neatitinka dokumentacijos skyriaus. Visas temas rasi dokumentacijos pradžioje.</CardDescription></CardHeader><CardContent><Button nativeButton={false} render={<Link href="/documentation" />}><ArrowLeft />Grįžti į dokumentaciją</Button></CardContent></Card></div>;
}
