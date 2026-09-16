import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArrowDown, Layers3 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { IntegrationWizard } from '@/features/documentation/setup/integration-wizard';
import { integrationSteps } from '@/features/documentation/setup/integration-steps';
import { SetupStepPagination, SetupStepsNav } from '@/features/documentation/setup/setup-steps-nav';
import '../setup.css';

export const dynamicParams = false;

export function generateStaticParams() {
  return integrationSteps.map((step) => ({ step: step.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ step: string }> }): Promise<Metadata> {
  const { step: slug } = await params;
  const step = integrationSteps.find((item) => item.slug === slug);
  return { title: step ? `${step.id}. ${step.title} · Mokėjimų diegimas` : 'Žingsnis nerastas', description: step?.description };
}

export default async function IntegrationStepPage({ params }: { params: Promise<{ step: string }> }) {
  const { step: slug } = await params;
  const step = integrationSteps.find((item) => item.slug === slug);
  if (!step) notFound();

  return (
    <div className="setup-page">
      <header className="setup-hero">
        <p className="setup-eyebrow"><Layers3 size={15} /> DIEGIMO INSTRUKCIJOS AGENTUI</p>
        <h1>{step.id}. {step.title}</h1>
        <p>{step.description}</p>
        <Badge variant="outline">Promptas {step.id} iš 05</Badge>
      </header>
      <SetupStepsNav current={step.id} />
      <Separator />

      <section id="integration-handoff" aria-labelledby="integration-handoff-title" className="integration-section">
        <div className="setup-section-heading"><span className="setup-kicker">ŽINGSNIO SUTARTIS</span><h2 id="integration-handoff-title">Pradžia ir rezultatas</h2><p>Formos užpildymas paruošia promptą. Užduotis baigta tada, kai agentas pateikia nurodytus failus ir patikrų rezultatus.</p></div>
        <div className="setup-rule-grid">
          <Card><CardHeader><CardTitle><h3>Ko reikia pradžioje</h3></CardTitle></CardHeader><CardContent><ul className="integration-list">{step.inputs.map((item) => <li key={item}>{item}</li>)}</ul></CardContent></Card>
          <Card><CardHeader><CardTitle><h3>Ką perduoti toliau</h3></CardTitle></CardHeader><CardContent><ul className="integration-list">{step.outputs.map((item) => <li key={item}>{item}</li>)}</ul></CardContent></Card>
        </div>
      </section>

      <Alert className="mb-7" role="note"><AlertDescription>Šiame puslapyje rengiama integracijos užduotis. Jis nesijungia prie Solidgate ar DB ir neatlieka mokėjimų. Į laukus įrašyk failų kelius bei aplinkos identifikatorius; API raktus laikyk projekto aplinkos kintamuosiuose.</AlertDescription></Alert>
      <Button className="mb-7" variant="outline" nativeButton={false} render={<a href="#integration-prompt" />}>Pereiti prie prompto<ArrowDown /></Button>
      <IntegrationWizard key={step.id} step={step} />

      <section id="integration-instructions" aria-labelledby="integration-instructions-title" className="integration-section">
        <div className="setup-section-heading"><span className="setup-kicker">INSTRUKCIJOS</span><h2 id="integration-instructions-title">Įgyvendinimo taisyklės</h2></div>
        <div className="integration-instructions">
          {step.sections.map((section, index) => <Card key={section.title}><CardHeader><div className="flex items-start gap-3"><Badge variant="outline" className="mt-0.5 font-mono">{index + 1}</Badge><CardTitle><h3>{section.title}</h3></CardTitle></div></CardHeader><CardContent><p className="integration-prose">{section.body}</p></CardContent></Card>)}
        </div>
      </section>
      <section id="integration-checks" aria-labelledby="integration-checks-title" className="integration-section">
        <Card><CardHeader><span className="setup-kicker">PRIĖMIMO KRITERIJAI</span><CardTitle><h2 id="integration-checks-title">Kada galima judėti toliau</h2></CardTitle></CardHeader><CardContent><ul className="integration-list">{step.checks.map((check) => <li key={check}>{check}</li>)}</ul><p className="mt-5 text-xs text-muted-foreground">Tai kriterijai agento ataskaitai. Puslapis jų automatiškai nepatvirtina ir nežymi integracijos užbaigta.</p></CardContent></Card>
      </section>
      <SetupStepPagination current={step.id} />
    </div>
  );
}
