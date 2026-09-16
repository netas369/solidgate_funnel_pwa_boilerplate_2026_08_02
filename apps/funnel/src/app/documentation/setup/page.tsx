import type { Metadata } from 'next';
import { ArrowRight, BookOpen, Braces, Globe2, Layers3 } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SetupWizard } from '@/features/documentation/setup/setup-wizard';
import { SetupFieldGuide } from '@/features/documentation/setup/field-guide';
import { SetupStepPagination, SetupStepsNav } from '@/features/documentation/setup/setup-steps-nav';
import { setupCopy as copy } from '@/features/documentation/setup/copy';
import './setup.css';

export const metadata: Metadata = {
  title: 'Naujo appso mokėjimai · Produktų kūrimas',
  description: 'Pirmas mokėjimų diegimo žingsnis: Solidgate produktų kodai, URL locale, kainos centiniais vienetais ir paruoštas agento promptas.',
};

export default function PaymentSetupPage() {
  return (
    <div className="setup-page">
      <header className="setup-hero">
        <p className="setup-eyebrow"><Layers3 size={15} /> DIEGIMO INSTRUKCIJOS AGENTUI</p>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <Card><CardContent className="setup-step-banner"><Badge variant="secondary" className="px-3 py-2 font-mono text-lg">01</Badge><div><strong>Produktų kūrimas</strong><span>Vienas produktas · valiutų kainos · checkout metadata</span></div><Badge variant="outline" className="setup-active-badge">Pirmas žingsnis</Badge></CardContent></Card>
      </header>

      <SetupStepsNav current="01" />
      <nav className="setup-section-nav" aria-label="Produkto kūrimo skyriai">
        {copy.sections.map((section) => <Button key={section.id} variant="ghost" size="sm" nativeButton={false} render={<a href={`#${section.id}`} />}>{section.label}</Button>)}
      </nav>
      <Separator />

      <section className="setup-rules" id="produkto-taisykles" aria-labelledby="setup-rules-title">
        <div className="setup-section-heading"><span className="setup-kicker">PRIEŠ PILDANT</span><h2 id="setup-rules-title">Vienas pasiūlymas. Aiškios taisyklės.</h2></div>
        <div className="setup-rule-grid">
          <Card><CardContent className="setup-rule-card"><Braces size={22} strokeWidth={1.6} /><h3>Transakcijos kodas</h3><code>{'{LOCALE}_{PRODNAME}_{YYMMDD}_SUB'}</code><p>Pavyzdys: <strong>CZ_MEMREPL_260510_SUB</strong>. Locale prefiksas pridedamas checkout metu. Bazinis kodas yra MEMREPL_260510_SUB; jo data lieka ta pati per pirkimus ir pratęsimus.</p></CardContent></Card>
          <Card><CardContent className="setup-rule-card"><Globe2 size={22} strokeWidth={1.6} /><h3>Locale iš svetainės URL</h3><code>/cz/quiz → CZ → CZ_MEMREPL_260510_SUB</code><p>Svetainės URL locale parenka transakcijos kodo prefiksą ir valiutos kainą. Visi šio pasiūlymo locale naudoja tą patį Solidgate produkto UUID.</p></CardContent></Card>
        </div>
        <Alert role="note" className="setup-route-note"><BookOpen size={19} /><AlertDescription>Boilerplate jau turi atitikmenis <code>/cz → cs</code>, <code>/tw → zh-TW</code> ir <code>/jp → ja</code>. Vertiname galutinį svetainės URL po nukreipimų; anglų locale jis gali būti be prefikso: <code>/quiz → en → EN</code>. Naujas produkto kodo formatas yra šio diegimo reikalavimas — agentas dar turi jį susieti su checkout ir patikrinti.</AlertDescription></Alert>
      </section>

      <SetupFieldGuide />
      <SetupWizard />

      <SetupStepPagination current="01" />
      <footer className="setup-footer"><div><strong>Šis žingsnis paruošia užduotį agentui.</strong><p>Vienas produktas ir jo valiutų kainos sukuriami tik tada, kai agentas įvykdo promptą pasirinktoje Solidgate aplinkoje. Surink visų main variantų ir OTO2 prenumeratos produktų bei kainų manifestą. Tada pereik į 02 žingsnį ir sujunk visą main + OTO katalogą.</p></div><Button variant="link" nativeButton={false} render={<Link href="/documentation/product-catalog" />}>Ankstesnio katalogo aprašymas <ArrowRight size={16} /></Button></footer>
    </div>
  );
}
