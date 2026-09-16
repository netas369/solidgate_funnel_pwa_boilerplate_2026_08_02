'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Copy, Download, FolderOpen, Plus, Save, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { buildIntegrationPrompt, createInitialIntegrationContext, isIntegrationContext, validateIntegrationContext, type IntegrationContext, type IntegrationOffer } from './integration-model';
import type { IntegrationStep } from './integration-steps';

const STORAGE_KEY = 'solidgate-documentation-integration-v1';
const PRODUCT_DRAFT_KEY = 'solidgate-documentation-setup-v2';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="setup-field"><Label htmlFor={id}>{label}</Label>{children}{hint ? <small id={`${id}-hint`}>{hint}</small> : null}</div>;
}

function normalizeStoredContext(value: unknown): unknown {
  return value && typeof value === 'object' ? { catalogVersion: '', ...value } : value;
}

function downloadFile(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function offerTitle(offer: IntegrationOffer, index: number) {
  return offer.placement === 'main' ? `Main variantas ${index + 1}` : `OTO${offer.step}`;
}

export function IntegrationWizard({ step }: { step: IntegrationStep }) {
  const [context, setContext] = useState(createInitialIntegrationContext);
  const [hydrated, setHydrated] = useState(false);
  const [storageStatus, setStorageStatus] = useState('Įkeliame šioje naršyklėje išsaugotą planą…');
  const [actionStatus, setActionStatus] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const validation = useMemo(() => validateIntegrationContext(context), [context]);
  const prompt = useMemo(() => validation.valid ? buildIntegrationPrompt(step, context) : '', [context, step, validation.valid]);
  const mainOffers = context.offers.filter((offer) => offer.placement === 'main');
  const otoOffers = context.offers.filter((offer) => offer.placement === 'oto');
  const editableOffers = step.id === '02';

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = normalizeStoredContext(JSON.parse(saved));
        if (isIntegrationContext(parsed)) {
          setContext(parsed);
          setStorageStatus(parsed.catalogVersion ? 'Išsaugotas planas atkurtas. Pakeitimai automatiškai saugomi tik šioje naršyklėje.' : 'Planas atkurtas. Įrašyk katalogo versiją; senesnis juodraštis jos neturėjo.');
        } else {
          setStorageStatus('Išsaugoto plano formatas netinkamas. Rodomi pradiniai laukai; senas įrašas dar nepakeistas.');
        }
      } else {
        setStorageStatus('Pakeitimai automatiškai saugomi tik šioje naršyklėje ir bendri 02–05 žingsniams.');
      }
    } catch {
      setStorageStatus('Nepavyko perskaityti vietinio plano. Gali pildyti laukus ir atsisiųsti JSON kopiją.');
    }
    setHydrated(true);
  }, []);

  const edited = useRef(false);
  useEffect(() => {
    if (!hydrated || !edited.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
      setStorageStatus('Pakeitimai išsaugoti šioje naršyklėje. Tas pats planas naudojamas 02–05 žingsniuose.');
    } catch {
      setStorageStatus('Naršyklė neleidžia išsaugoti plano. Atsisiųsk JSON kopiją prieš pereidamas į kitą puslapį.');
    }
  }, [context, hydrated]);

  function update(values: Partial<IntegrationContext>) {
    edited.current = true;
    setContext((previous) => {
      const next = { ...previous, ...values };
      if (values.providerManifestPath !== undefined && !values.offers) {
        next.offers = previous.offers.map((offer) => offer.billingType === 'subscription' && offer.pricingReference === previous.providerManifestPath
          ? { ...offer, pricingReference: values.providerManifestPath! }
          : offer);
      }
      return next;
    });
    setActionStatus('');
  }

  function updateOffer(id: string, values: Partial<IntegrationOffer>) {
    edited.current = true;
    setContext((previous) => ({ ...previous, offers: previous.offers.map((offer) => offer.id === id ? { ...offer, ...values } : offer) }));
    setActionStatus('');
  }

  function addMainVariant() {
    update({ offers: [...mainOffers, {
      id: `main-${crypto.randomUUID()}`,
      placement: 'main',
      step: null,
      offerKey: '',
      billingType: 'subscription',
      entitlementKey: mainOffers[0]?.entitlementKey ?? '',
      pricingReference: context.providerManifestPath,
      afterPurchase: 'grant_only',
    }, ...otoOffers] });
  }

  function addOtoChoice() {
    const existing = otoOffers.find((offer) => offer.step === 3);
    update({ offers: [...context.offers, {
      id: `oto3-${crypto.randomUUID()}`, placement: 'oto', step: 3,
      offerKey: '', billingType: 'one_time', entitlementKey: existing?.entitlementKey ?? 'oto3',
      pricingReference: existing?.pricingReference ?? '', afterPurchase: 'grant_only',
    }] });
  }

  function savePlan() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
      setStorageStatus('Planas išsaugotas šioje naršyklėje. Užpildyti laukai nėra atliktos integracijos patvirtinimas.');
    } catch {
      setStorageStatus('Nepavyko išsaugoti. Atsisiųsk JSON kopiją.');
    }
  }

  function restorePlan() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) { setStorageStatus('Šioje naršyklėje dar nėra išsaugoto integracijos plano.'); return; }
      const saved = normalizeStoredContext(JSON.parse(raw));
      if (!isIntegrationContext(saved)) { setStorageStatus('Plano formatas neatpažintas. Dabartiniai laukai nepakeisti.'); return; }
      edited.current = false;
      setContext(saved);
      setStorageStatus('Atkurtas paskutinis šioje naršyklėje išsaugotas planas.');
      setActionStatus('');
    } catch {
      setStorageStatus('Nepavyko perskaityti išsaugoto plano. Dabartiniai laukai nepakeisti.');
    }
  }

  function importProductDraft() {
    try {
      const raw = localStorage.getItem(PRODUCT_DRAFT_KEY);
      if (!raw) { setActionStatus('01 žingsnyje pirmiausia išsaugok produkto formą šioje naršyklėje.'); return; }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid draft');
      const wrapper = parsed as Record<string, unknown>;
      if (wrapper.version !== 2 || !wrapper.config || typeof wrapper.config !== 'object') throw new Error('Invalid draft');
      const draft = wrapper.config as Record<string, unknown>;
      if (typeof draft.appKey !== 'string' || typeof draft.channelReference !== 'string' || !['sandbox', 'production'].includes(String(draft.environment))) throw new Error('Invalid draft');
      const emptyPlan = !context.appKey.trim() && !context.channelReference.trim();
      const date = typeof draft.batchDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(draft.batchDate) ? draft.batchDate.slice(2).replaceAll('-', '') : '';
      update({
        catalogVersion: context.catalogVersion.trim() || (date ? `catalog-${date}` : ''),
        appKey: context.appKey.trim() ? context.appKey : draft.appKey,
        channelReference: context.channelReference.trim() ? context.channelReference : draft.channelReference,
        environment: emptyPlan ? draft.environment as IntegrationContext['environment'] : context.environment,
      });
      setActionStatus('Iš 01 juodraščio užpildyti tik tušti app_key, katalogo versijos ir kanalo laukai. Aplinka perimta tik jei abu buvo tušti. Produktų ID ir visi pasiūlymai turi būti patikrintame manifeste.');
    } catch {
      setActionStatus('01 žingsnio juodraštis neatpažintas. Dabartiniai laukai nepakeisti.');
    }
  }

  async function copyPrompt() {
    if (!validation.valid) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setActionStatus('Promptas nukopijuotas. Perduok agentui kartu su nurodytais įvesties failais.');
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      setActionStatus('Naršyklė neleido kopijuoti. Promptas pažymėtas — paspausk Cmd+C arba Ctrl+C.');
    }
  }

  const fieldInvalid = (path: string) => validation.issues.some((issue) => issue.path === path);
  const filename = `${context.appKey.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'app'}-solidgate-${step.id}`;

  function renderOffer(offer: IntegrationOffer, index: number) {
    const originalIndex = context.offers.findIndex((item) => item.id === offer.id);
    const choiceCount = otoOffers.filter((item) => item.step === offer.step).length;
    const removable = (offer.placement === 'main' && mainOffers.length > 1) || (offer.placement === 'oto' && offer.step === 3 && choiceCount > 1);
    const title = `${offerTitle(offer, index)}${offer.placement === 'oto' && offer.step === 3 && choiceCount > 1 ? ` · ${offer.offerKey || 'naujas pasirinkimas'}` : ''}`;
    const id = `integration-offer-${offer.id}`;
    return (
      <Card key={offer.id}>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle><h3>{title}</h3></CardTitle><div className="flex items-center gap-2"><Badge variant={offer.billingType === 'subscription' ? 'secondary' : 'outline'}>{offer.billingType === 'subscription' ? 'Prenumerata' : 'Vienkartinis'}</Badge>{removable ? <Button variant="ghost" size="icon-sm" aria-label={`Pašalinti ${title}`} onClick={() => update({ offers: context.offers.filter((row) => row.id !== offer.id) })}><Trash2 /></Button> : null}</div></div></CardHeader>
        <CardContent><div className="setup-fields-grid">
          <Field id={`${id}-key`} label="Pasiūlymo kodas / product_slug" hint={offer.placement === 'oto' ? `OTO${offer.step} kodas prasideda oto${offer.step}_, kaip numato grįžimas po 3DS.` : 'Runtime kodas transakcijos metadata. Susiejamas su provider catalog_key manifeste; šie kodai gali skirtis.'}><Input id={`${id}-key`} value={offer.offerKey} onChange={(event) => updateOffer(offer.id, { offerKey: event.target.value })} aria-invalid={fieldInvalid(`offers.${originalIndex}.offerKey`)} placeholder={offer.placement === 'main' ? 'main_trial1' : `oto${offer.step}_offer`} /></Field>
          <Field id={`${id}-billing`} label="Mokėjimo tipas" hint={offer.placement === 'main' ? 'Kiekvienas main trial variantas yra prenumerata.' : offer.step === 2 ? 'OTO2 yra vienintelė OTO prenumerata.' : 'Ši OTO pozicija yra vienkartinis mokėjimas.'}><NativeSelect className="w-full" id={`${id}-billing`} value={offer.billingType} onChange={(event) => updateOffer(offer.id, { billingType: event.target.value as IntegrationOffer['billingType'] })} aria-invalid={fieldInvalid(`offers.${originalIndex}.billingType`)}><NativeSelectOption value="subscription">Subscription — prenumerata</NativeSelectOption><NativeSelectOption value="one_time">One-time — vienkartinis</NativeSelectOption></NativeSelect></Field>
          <Field id={`${id}-entitlement`} label="Suteikiama prieiga / entitlement_key" hint="Aprašo, ką klientas gauna. Main trial variantai gali suteikti tą pačią prieigą."><Input id={`${id}-entitlement`} value={offer.entitlementKey} onChange={(event) => updateOffer(offer.id, { entitlementKey: event.target.value })} aria-invalid={fieldInvalid(`offers.${originalIndex}.entitlementKey`)} placeholder="premium_access" /></Field>
          <Field id={`${id}-pricing`} label="Kainų failas / pricing_reference" hint={offer.billingType === 'subscription' ? 'Manifestas su konkretaus pasiūlymo produkto ir visų reikalingų valiutų kainų ID.' : 'Repo failas su aiškiomis šio pasiūlymo kainomis visoms palaikomoms valiutoms, minor units.'}><Input id={`${id}-pricing`} value={offer.pricingReference} onChange={(event) => updateOffer(offer.id, { pricingReference: event.target.value })} aria-invalid={fieldInvalid(`offers.${originalIndex}.pricingReference`)} placeholder="docs/payments/setup/one-time-prices.json" /></Field>
          {offer.placement === 'oto' && offer.step === 1 ? <Field id={`${id}-after`} label="Po sėkmingo OTO1 mokėjimo" hint="Lifetime scenarijui atšaukimas leidžiamas tik po patvirtinto capture / settle. Kitas vienkartinis produktas gali tik suteikti prieigą."><NativeSelect className="w-full" id={`${id}-after`} value={offer.afterPurchase} onChange={(event) => updateOffer(offer.id, { afterPurchase: event.target.value as IntegrationOffer['afterPurchase'] })}><NativeSelectOption value="grant_only">Tik suteikti prieigą</NativeSelectOption><NativeSelectOption value="cancel_main_after_capture">Suteikti prieigą ir nutraukti main prenumeratą</NativeSelectOption></NativeSelect></Field> : <div className="setup-field"><span className="text-sm font-medium">Po sėkmingo mokėjimo</span><p className="text-sm text-muted-foreground">Suteikti šio pasiūlymo prieigą. Kitų prenumeratų neatšaukti.</p></div>}
        </div></CardContent>
      </Card>
    );
  }

  return (
    <div className="integration-wizard">
      <section id="integration-context" aria-labelledby="integration-context-title" className="setup-panel">
        <Card><CardContent className="setup-panel-content">
          <div className="setup-panel-header"><div><span className="setup-kicker">BENDRI 02–05 ŽINGSNIŲ LAUKAI</span><h2 id="integration-context-title">Integracijos planas</h2><p>Įrašyk appso ir failų identifikatorius. Agentas turės perskaityti nurodytus failus ir patikrinti jų turinį.</p></div><Badge variant="outline">Vietinis juodraštis</Badge></div>
          <div className="setup-draft-bar"><span role="status">{storageStatus}</span><Button size="sm" variant="outline" onClick={savePlan} disabled={!hydrated}><Save />Išsaugoti</Button><Button size="sm" variant="outline" onClick={restorePlan} disabled={!hydrated}><FolderOpen />Atkurti</Button><Button size="sm" variant="outline" onClick={importProductDraft} disabled={!hydrated}>Perimti 01 laukus</Button></div>
          <div className="setup-fields-grid">
            <Field id="integration-app-key" label="Appso kodas / app_key" hint="Tas pats identifikatorius kaip 01 produktų manifeste."><Input id="integration-app-key" value={context.appKey} onChange={(event) => update({ appKey: event.target.value })} aria-invalid={fieldInvalid('appKey')} placeholder="my_app" /></Field>
            <Field id="integration-catalog-version" label="Aktyvi katalogo versija" hint="Tiksliai pasirinkta manifesto versija, pvz., catalog-260510. Agentas neturi tyliai pasirinkti naujausios ar istorinės versijos."><Input id="integration-catalog-version" value={context.catalogVersion} onChange={(event) => update({ catalogVersion: event.target.value })} aria-invalid={fieldInvalid('catalogVersion')} placeholder="catalog-260510" /></Field>
            <Field id="integration-repo" label="Projekto katalogas" hint="Repo kelias agento darbo aplinkoje; taškas reiškia dabartinį repo."><Input id="integration-repo" value={context.repoPath} onChange={(event) => update({ repoPath: event.target.value })} aria-invalid={fieldInvalid('repoPath')} /></Field>
            <Field id="integration-environment" label="Solidgate aplinka" hint="Visi manifestai ir kanalai turi priklausyti tai pačiai aplinkai. 05 mokėjimų scenarijai vykdomi tik sandbox."><NativeSelect className="w-full" id="integration-environment" value={context.environment} onChange={(event) => update({ environment: event.target.value as IntegrationContext['environment'] })}><NativeSelectOption value="sandbox">Sandbox</NativeSelectOption><NativeSelectOption value="production">Production katalogo kontekstas</NativeSelectOption></NativeSelect></Field>
            <Field id="integration-channel" label="Solidgate kanalo nuoroda" hint="Kanalo pavadinimas arba ID. Čia neįrašyk API rakto."><Input id="integration-channel" value={context.channelReference} onChange={(event) => update({ channelReference: event.target.value })} aria-invalid={fieldInvalid('channelReference')} placeholder="app_sandbox" /></Field>
            <Field id="integration-manifest" label="01 produktų ir kainų manifestas" hint="Vienas failas arba manifestų indeksas su visais main variantais ir OTO2 produktu. Vienos neužbaigtos 01 formos JSON nepakanka."><Input id="integration-manifest" value={context.providerManifestPath} onChange={(event) => update({ providerManifestPath: event.target.value })} aria-invalid={fieldInvalid('providerManifestPath')} /></Field>
          </div>
        </CardContent></Card>
      </section>

      <section id="integration-offers" aria-labelledby="integration-offers-title" className="integration-section">
        <div className="setup-panel-header mb-6"><div><span className="setup-kicker">VISAS PIRKIMO SRAUTAS</span><h2 id="integration-offers-title">Main ir OTO pasiūlymai</h2><p>{editableOffers ? 'Pridėk visus realiai naudojamus main variantus ir užpildyk kiekvieną OTO pasiūlymą. Kainų sumos lieka viename nurodytame šaltinyje.' : 'Šis sąrašas atkurtas iš bendro integracijos plano. Pasiūlymus, mokėjimo tipus ir kainų nuorodas redaguok 02 žingsnyje.'}</p></div>{!editableOffers ? <Button variant="outline" nativeButton={false} render={<Link href="/documentation/setup/catalog-integration#integration-offers" />}><ArrowLeft />Keisti 02 žingsnyje</Button> : null}</div>
        <Alert role="note" className="mb-6"><AlertTitle>Vienintelė OTO prenumerata — OTO2</AlertTitle><AlertDescription>Main ir OTO2 turi atskirus subscription_id, renewal įvykius ir atšaukimo būsenas. OTO1 ir OTO3–OTO7 yra vienkartiniai mokėjimai. OTO3 gali turėti kelis alternatyvius pasirinkimus viename žingsnyje. OTO8 — užbaigimo puslapis, papildomo mokėjimo nėra. Produkto kodo galūnė nenustato billing_type.</AlertDescription></Alert>
        <div className="setup-product-summary mb-5"><Badge variant="outline">Main variantų: {mainOffers.length}</Badge><Badge variant="outline">OTO prenumeratų: {otoOffers.filter((offer) => offer.billingType === 'subscription').length}</Badge><Badge variant="outline">Vienkartinių OTO pasiūlymų: {otoOffers.filter((offer) => offer.billingType === 'one_time').length}</Badge></div>
        {editableOffers ? <div className="integration-offer-list"><div className="integration-offer-group">{mainOffers.map(renderOffer)}<Button variant="outline" onClick={addMainVariant}><Plus />Pridėti main variantą</Button></div><div className="integration-offer-group">{[...otoOffers].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)).map(renderOffer)}<Button variant="outline" onClick={addOtoChoice}><Plus />Pridėti OTO3 pasirinkimą</Button></div></div> : <Card><CardContent className="min-w-0"><Table><TableHeader><TableRow><TableHead>Pozicija</TableHead><TableHead>Pasiūlymas</TableHead><TableHead>Tipas</TableHead><TableHead>Prieiga</TableHead><TableHead>Kainų šaltinis</TableHead></TableRow></TableHeader><TableBody>{context.offers.map((offer, index) => <TableRow key={offer.id}><TableCell>{offerTitle(offer, index)}</TableCell><TableCell><code>{offer.offerKey || 'Neįrašyta'}</code></TableCell><TableCell>{offer.billingType}</TableCell><TableCell><code>{offer.entitlementKey || 'Neįrašyta'}</code></TableCell><TableCell className="max-w-64 whitespace-normal"><code>{offer.pricingReference || 'Neįrašyta'}</code>{offer.afterPurchase === 'cancel_main_after_capture' ? <p className="mt-2 text-xs text-muted-foreground">Po capture nutraukia main prenumeratą</p> : null}</TableCell></TableRow>)}</TableBody></Table></CardContent></Card>}
      </section>

      <section id="integration-prompt" aria-labelledby="integration-prompt-title" className="setup-panel">
        <Card><CardContent className="setup-panel-content"><div className="setup-panel-header"><div><span className="setup-kicker">UŽDUOTIS AGENTUI</span><h2 id="integration-prompt-title">{step.id} promptas</h2><p>Promptas sujungia šio žingsnio taisykles su tavo integracijos planu. Failų keliai įdedami kaip nuorodos — jų turinį agentas tikrina repo.</p></div><Badge variant={validation.valid ? 'secondary' : 'outline'}>{validation.valid ? 'Laukai užpildyti' : 'Trūksta duomenų'}</Badge></div>
          {!validation.valid ? <Alert className="setup-validation"><AlertTitle>Prieš kopijuodamas pataisyk laukus</AlertTitle><AlertDescription><ul>{validation.issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul>{!editableOffers ? <Button className="mt-4" variant="outline" nativeButton={false} render={<Link href="/documentation/setup/catalog-integration#integration-offers" />}>Pildyti pasiūlymus 02 žingsnyje</Button> : null}</AlertDescription></Alert> : <Alert role="note"><Check /><AlertDescription>Formos struktūra tinkama promptui. Manifesto egzistavimas, kainų teisingumas ir integracijos veikimas dar turi būti patikrinti agento.</AlertDescription></Alert>}
          <Label htmlFor={`integration-prompt-${step.id}`} className="sr-only">Sugeneruotas {step.id} žingsnio promptas</Label><Textarea ref={promptRef} id={`integration-prompt-${step.id}`} className="setup-prompt-text" value={prompt} readOnly placeholder="Užpildyk bendrus laukus ir visą pasiūlymų planą. Čia atsiras pilnas promptas agentui." spellCheck={false} />
          <div className="setup-prompt-actions"><Button onClick={copyPrompt} disabled={!validation.valid || !hydrated}><Copy />Kopijuoti {step.id} promptą</Button><Button variant="outline" onClick={() => downloadFile(prompt, `${filename}-prompt.md`, 'text/markdown;charset=utf-8')} disabled={!validation.valid || !hydrated}><Download />Atsisiųsti promptą</Button><Button variant="outline" onClick={() => downloadFile(JSON.stringify(context, null, 2), `${filename}-plan.json`, 'application/json')} disabled={!hydrated}><Download />Atsisiųsti plano JSON</Button></div>
          <p role="status" className="setup-copy-status">{actionStatus}</p>
        </CardContent></Card>
      </section>
    </div>
  );
}
